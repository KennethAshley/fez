import { readAgentNostrKey } from "./store.js";
import { loadConfig } from "./config.js";
import { buildReceipt } from "./receipt.js";
import { formatRao } from "./chains/subtensor.js";
import { parseAmount } from "./chains/adapter.js";
import { mirrorSpend } from "./storage-mirror.js";
import { ambiguousTransferError, signerFromPair, submitAndWait } from "./chains/substrate.js";
import { requirePersonaPair, requireRehearsalNetwork, subtensorFor } from "./stake.js";
import { splitFee } from "./fees.js";

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

export async function marketPublish(relayUrl: string, event: SignedEvent): Promise<void> {
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
  /** Protocol fee skimmed to the burn vault (spec 2026-09-04); absent
   *  when fees are off on this machine. */
  fee?: string;
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
  // The fee burn (spec 2026-09-04): the miner receives net, the vault
  // accrues the fee, one atomic batch. With no vault derived here the
  // split is a no-op and the tick flows whole.
  const { netRao, feeRao, vault } = splitFee(amountRao);
  const tickTx = feeRao > 0n && vault
    ? api.tx.utility.batchAll([
        api.tx.balances.transferKeepAlive(offer.payTo, netRao),
        api.tx.balances.transferKeepAlive(vault, feeRao),
      ])
    : api.tx.balances.transferKeepAlive(offer.payTo, amountRao);
  const { txHash, blockRef } = await submitAndWait(
    api,
    tickTx,
    signer,
    { onTimeout: () => ambiguousTransferError(offer.payTo, 120_000) }
  );

  // The receipt is the tick. It rides the MARKET relay because that is
  // where the miner listens — a receipt on the renter's workspace relay
  // would be a payment the lease never hears about. The amount is what
  // the MINER received (net of fee) — the payout is disclosed, never
  // silent, and the miner's lease ledger must meter what actually landed.
  const receipt = buildReceipt({
    agentSecretHex: nostrKey,
    payeePubkey: minerPk,
    amount: { raw: netRao, decimals: 9, symbol: "TAO" },
    chain: "tao",
    network: config.network,
    txHash,
    blockRef,
    memo: "lease",
  });
  await marketPublish(relayUrl, receipt as SignedEvent);

  return { persona, miner: minerPk, hours, amount: formatRao(amountRao), ...(feeRao > 0n ? { fee: formatRao(feeRao) } : {}), txHash, receiptId: receipt.id };
}

export interface PayResult { persona: string; to: string; amount: string; fee?: string; txHash: string; receiptId?: string }

/**
 * Settle a hire: pay a flat amount to an address, and publish a receipt
 * that ties the payment to the hire (the directed-task root) so the
 * agent's owner can see it landed. The negotiated-lump settle (model A):
 * you agreed a number in the DM, this pays it. Root-free (persona-signed,
 * mcp/desktop-safe), testnet-gated like the other write verbs.
 */
export async function payAddress(
  persona: string,
  to: string,
  amount: string,
  opts: { forEvent?: string; payeePk?: string; relayUrl?: string; memo?: string } = {}
): Promise<PayResult> {
  if (!/^5[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(to)) throw new Error("recipient must be an ss58 address");
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  requireRehearsalNetwork(config.network);
  const amountRao = parseAmount(amount, 9, "TAO").raw;
  if (amountRao <= 0n) throw new Error("amount must be greater than zero");
  const api = await subtensorFor(config.endpoints.tao);
  const free = (await api.query.system.account(pair.address)).data.free.toBigInt();
  if (free < amountRao) throw new Error(`${persona} has ${formatRao(free)} tTAO free; paying ${amount} needs funding first`);

  const signer = await signerFromPair(pair);
  // Same skim as the lease tick: payee gets net, the vault gets the fee,
  // atomically. No vault on this machine → the payment flows whole.
  const { netRao, feeRao, vault } = splitFee(amountRao);
  const payTx = feeRao > 0n && vault
    ? api.tx.utility.batchAll([
        api.tx.balances.transferKeepAlive(to, netRao),
        api.tx.balances.transferKeepAlive(vault, feeRao),
      ])
    : api.tx.balances.transferKeepAlive(to, amountRao);
  const { txHash, blockRef } = await submitAndWait(
    api,
    payTx,
    signer,
    { onTimeout: () => ambiguousTransferError(to, 120_000) }
  );

  // Record it where the wallet PANEL reads its ledger — the mirror's
  // `logs` (mirrorSpend), NOT the standalone wallet-log file. A settle
  // that moved money invisibly to the UI would be exactly wrong. Best-
  // effort: the transfer already landed.
  try {
    await mirrorSpend({
      ts: new Date().toISOString(),
      persona, to, amount: formatRao(amountRao), asset: "TAO", txHash,
      memo: opts.memo ?? "hire", consent: "approved", network: config.network,
    });
  } catch { /* the money moved; a log hiccup must not read as failure */ }

  // A receipt makes the settlement legible: proof-of-payment tied to the
  // hire's task root, on the market relay where the counterparty watches.
  // Best-effort — the transfer already happened; a relay hiccup must not
  // read as a failed payment.
  let receiptId: string | undefined;
  const nostrKey = readAgentNostrKey(persona);
  if (nostrKey) {
    try {
      const receipt = buildReceipt({
        agentSecretHex: nostrKey,
        ...(opts.forEvent ? { forEvent: opts.forEvent } : {}),
        ...(opts.payeePk ? { payeePubkey: opts.payeePk } : {}),
        // Net of the protocol fee — the receipt states what the payee GOT.
        amount: { raw: netRao, decimals: 9, symbol: "TAO" },
        chain: "tao",
        network: config.network,
        txHash,
        blockRef,
        memo: opts.memo ?? "hire",
      });
      await marketPublish(opts.relayUrl ?? DEFAULT_MARKET_RELAY, receipt as SignedEvent);
      receiptId = receipt.id;
    } catch { /* payment stood; receipt is a courtesy */ }
  }
  return { persona, to, amount: formatRao(amountRao), ...(feeRao > 0n ? { fee: formatRao(feeRao) } : {}), txHash, receiptId };
}
