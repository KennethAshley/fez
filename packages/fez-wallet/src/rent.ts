import { readAgentNostrKey } from "./store.js";
import { loadConfig } from "./config.js";
import { buildReceipt } from "./receipt.js";
import { formatRao } from "./chains/subtensor.js";
import { ambiguousTransferError, signerFromPair, submitAndWait } from "./chains/substrate.js";
import { requirePersonaPair, requireRehearsalNetwork, subtensorFor } from "./stake.js";

/**
 * Streaming leases, renter side (spec 2026-09-03): rent someone else's
 * agent by paying its announced hourly rate from THIS persona's own
 * allowance. One call = one tick = `hours` of paid attention:
 *
 *   1. read the miner's standing offer from its latest announce
 *      (rate.tao_hr + rate.pay_to — no offer, no lease, no handshake);
 *   2. transfer hours × rate from the persona's account to pay_to;
 *   3. publish the 47040 receipt to the MARKET relay, p-tagging the
 *      miner — the receipt IS the tick; the miner's ledger does the rest.
 *
 * Prepaid and unilateral: the renter risks exactly this tick, the miner
 * is never owed anything, and stopping is just not calling again.
 * Root-free on purpose — mcp.ts imports this, so agents rent agents.
 */

export const DEFAULT_MARKET_RELAY = "wss://bazaar.fez.chat";

interface SignedEvent { id: string; pubkey: string; kind: number; content: string; tags: string[][]; created_at: number; sig: string }

/**
 * A raw-WebSocket round trip to the market relay — one REQ, collect until
 * EOSE, one publish. The wallet's SimplePool (poolRelay) comes back empty
 * against the bazaar relay — the same quirk that made the bazaar GUI open
 * its OWN socket rather than read through the client. The market relay is
 * anonymous by design, so no auth is needed either way.
 */
async function marketQuery(relayUrl: string, filter: Record<string, unknown>): Promise<SignedEvent[]> {
  const WS = (await import("ws")).default;
  return new Promise((resolve, reject) => {
    const ws = new WS(relayUrl);
    const out: SignedEvent[] = [];
    const done = (fn: () => void) => { try { ws.close(); } catch { /* already closing */ } fn(); };
    const timer = setTimeout(() => done(() => resolve(out)), 8000);
    ws.onopen = () => ws.send(JSON.stringify(["REQ", "rent", filter]));
    ws.onerror = () => { clearTimeout(timer); done(() => reject(new Error(`cannot reach ${relayUrl}`))); };
    ws.onmessage = (m) => {
      let msg: unknown[];
      try { msg = JSON.parse(String(m.data)) as unknown[]; } catch { return; }
      if (msg[0] === "EVENT") out.push(msg[2] as SignedEvent);
      else if (msg[0] === "EOSE") { clearTimeout(timer); done(() => resolve(out)); }
    };
  });
}

async function marketPublish(relayUrl: string, event: SignedEvent): Promise<void> {
  const WS = (await import("ws")).default;
  return new Promise((resolve, reject) => {
    const ws = new WS(relayUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error("tick publish timed out")); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot reach ${relayUrl}`)); };
    ws.onmessage = (m) => {
      let msg: unknown[];
      try { msg = JSON.parse(String(m.data)) as unknown[]; } catch { return; }
      if (msg[0] === "OK") { clearTimeout(timer); try { ws.close(); } catch { /* */ } msg[2] ? resolve() : reject(new Error(`relay rejected the tick: ${msg[3] ?? "no reason"}`)); }
    };
  });
}

interface Offer {
  taoHr: number;
  payTo: string;
}

/** The miner's standing offer from its freshest announce, or a plain
 * sentence about why it can't be rented. */
export function offerFromAnnounces(events: { created_at: number; content: string }[]): Offer {
  const newest = [...events].sort((a, b) => b.created_at - a.created_at);
  for (const ev of newest) {
    try {
      const beat = JSON.parse(ev.content) as { rate?: { tao_hr?: number; pay_to?: string } };
      if (beat.rate?.tao_hr && beat.rate.tao_hr > 0 && beat.rate.pay_to) {
        return { taoHr: beat.rate.tao_hr, payTo: beat.rate.pay_to };
      }
      // The freshest announce speaks for the miner: if it carries no
      // offer, the agent is not for rent NOW, whatever older beats said.
      break;
    } catch { /* unparseable beat — try an older one */ }
  }
  throw new Error("this agent is not for rent — its announce carries no rate");
}

export interface RentResult {
  persona: string;
  miner: string;
  hours: number;
  amount: string;
  txHash: string;
  receiptId: string;
}

export async function rentAgent(
  persona: string,
  minerPk: string,
  hours: number,
  relayUrl = DEFAULT_MARKET_RELAY
): Promise<RentResult> {
  if (!/^[0-9a-f]{64}$/.test(minerPk)) throw new Error("miner must be a 64-hex nostr pubkey");
  if (!(hours > 0) || hours > 24) throw new Error("hours must be between 0 and 24 — a lease is a tick, not a marriage");
  const pair = requirePersonaPair(persona);
  const nostrKey = readAgentNostrKey(persona);
  if (!nostrKey) throw new Error(`${persona} has no nostr identity on this machine — the tick receipt must be signed as ${persona}`);
  const config = loadConfig();
  requireRehearsalNetwork(config.network);

  const announces = await marketQuery(relayUrl, { kinds: [47000], authors: [minerPk], limit: 20 });
  const offer = offerFromAnnounces(announces);

  const amountRao = BigInt(Math.round(hours * offer.taoHr * 1e9));
  if (amountRao <= 0n) throw new Error("that lease rounds to nothing — rent longer or rent someone pricier");

  const api = await subtensorFor(config.endpoints.tao);
  const acct = await api.query.system.account(pair.address);
  const free = acct.data.free.toBigInt();
  if (free < amountRao) {
    throw new Error(`${persona} has ${formatRao(free)} tTAO free; ${hours}h at ${offer.taoHr} tTAO/hr needs ${formatRao(amountRao)}`);
  }

  const signer = await signerFromPair(pair);
  const { txHash, blockRef } = await submitAndWait(
    api,
    api.tx.balances.transferKeepAlive(offer.payTo, amountRao),
    signer,
    { onTimeout: () => ambiguousTransferError(offer.payTo, 120_000) }
  );

  // The receipt is the tick. It rides the MARKET relay because that is
  // where the miner listens — a receipt on the renter's workspace relay
  // would be a payment the lease never hears about.
  const receipt = buildReceipt({
    agentSecretHex: nostrKey,
    payeePubkey: minerPk,
    amount: { raw: amountRao, decimals: 9, symbol: "TAO" },
    chain: "tao",
    network: config.network,
    txHash,
    blockRef,
    memo: "lease",
  });
  await marketPublish(relayUrl, receipt as SignedEvent);

  return { persona, miner: minerPk, hours, amount: formatRao(amountRao), txHash, receiptId: receipt.id };
}
