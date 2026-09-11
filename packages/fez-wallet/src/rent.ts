import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { parseGuestEvent, replaceableEventWins } from "../../fez-client/src/guest-protocol.js";
import { readAgentNostrKey } from "./store.js";
import { loadConfig } from "./config.js";
import { buildReceipt } from "./receipt.js";
import { formatRao } from "./chains/subtensor.js";
import { parseAmount } from "./chains/adapter.js";
import { mirrorSpend } from "./storage-mirror.js";
import { ambiguousTransferError, signerFromPair, submitAndWait } from "./chains/substrate.js";
import { requirePersonaPair, requireRehearsalNetwork, requireExpectedPayer, isTaoAddress, subtensorFor } from "./stake.js";
import { requireWalletMutationAllowed } from "./evaluation.js";
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
    let finished = false;
    const done = (fn: () => void) => { if (finished) return; finished = true; clearTimeout(timer); try { ws.close(); } catch { /* already closing */ } fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("offer query timed out — no payment was made"))), 8000);
    ws.onopen = () => ws.send(JSON.stringify(["REQ", "rent", filter]));
    ws.onerror = () => { clearTimeout(timer); done(() => reject(new Error(`cannot reach ${relayUrl}`))); };
    ws.onmessage = (m) => {
      let msg: unknown[];
      try { msg = JSON.parse(String(m.data)) as unknown[]; } catch { return; }
      if (!Array.isArray(msg) || finished || msg[1] !== "rent") return;
      if (msg[0] === "EVENT") out.push(msg[2] as SignedEvent);
      else if (msg[0] === "EOSE") { clearTimeout(timer); done(() => resolve(out)); }
    };
  });
}

export async function marketPublish(relayUrl: string, event: SignedEvent): Promise<void> {
  const WS = (await import("ws")).default;
  return new Promise((resolve, reject) => {
    const ws = new WS(relayUrl);
    let finished = false;
    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => done(new Error("tick publish timed out")), 8000);
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
    ws.onerror = () => done(new Error(`cannot reach ${relayUrl}`));
    ws.onmessage = (m) => {
      let msg: unknown;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (!Array.isArray(msg) || msg[0] !== "OK" || msg[1] !== event.id || typeof msg[2] !== "boolean") return;
      done(msg[2] ? undefined : new Error("relay rejected the tick"));
    };
  });
}

interface Offer { taoHr: number; payTo: string; offerId: string }

/** Only the latest authentic announcement can authorize payment. Invalid or
 * withdrawn terms supersede an older offer just as valid terms do. */
export function offerFromAnnounces(events: unknown[], minerPk: string, nowS = Math.floor(Date.now() / 1000)): Offer {
  let latest: Extract<ReturnType<typeof parseGuestEvent>, { type: "announce" }> | undefined;
  for (const raw of events) {
    const parsed = parseGuestEvent(raw, { guestPk: minerPk, nowS, validatePayTo: isTaoAddress });
    if (parsed?.type === "announce" && replaceableEventWins(parsed.event, latest?.event)) latest = parsed;
  }
  if (!latest || nowS - latest.event.created_at > 15 * 60) throw new Error("no fresh signed rental offer from this agent");
  const offer = latest.offer;
  if (!offer?.payTo || !offer.rateTaoHr) throw new Error("this agent is not for rent — its latest announce has no valid offer");
  return { taoHr: offer.rateTaoHr, payTo: offer.payTo, offerId: latest.event.id };
}

export interface RentOptions {
  expectedQuote?: { payTo: string; rateTaoHr: number; offerId?: string };
  expectedPayer?: string;
  expectedRenter?: string;
  maxAmount?: string;
  forEvent?: string;
}

export interface RentResult {
  persona: string; miner: string; hours: number; amount: string; fee?: string;
  payerAddress: string; renterPubkey: string; payTo: string; rateTaoHr: number; offerId: string; network: "test";
  /** The recipient's net paid time after protocol fees. */
  paidHours: number;
  forEvent?: string;
  txHash: string;
  receiptId?: string;
  receiptPublished: boolean;
  /** A confirmed transfer remains a success even if the receipt needs recovery. */
  receiptError?: string;
}

/** Public identity for the desktop's lease eligibility check. No network call or key mutation. */
export function rentalIdentity(persona: string): { persona: string; payerAddress: string; renterPubkey: string | null } {
  const pair = requirePersonaPair(persona);
  const nostrKey = readAgentNostrKey(persona);
  return { persona, payerAddress: pair.address, renterPubkey: nostrKey ? getPublicKey(hexToBytes(nostrKey)) : null };
}

export async function rentAgent(
  persona: string,
  minerPk: string,
  hours: number,
  relayUrl = DEFAULT_MARKET_RELAY,
  opts: RentOptions = {}
): Promise<RentResult> {
  requireWalletMutationAllowed();
  if (!/^[0-9a-f]{64}$/.test(minerPk)) throw new Error("miner must be a 64-hex nostr pubkey");
  if (!Number.isFinite(hours) || !(hours > 0) || hours > 24) throw new Error("hours must be between 0 and 24 — a lease is a tick, not a marriage");
  const pair = requirePersonaPair(persona);
  const nostrKey = readAgentNostrKey(persona);
  if (!nostrKey) throw new Error(`${persona} has no nostr identity on this machine — the tick receipt must be signed as ${persona}`);
  const renterPubkey = getPublicKey(hexToBytes(nostrKey));
  if (opts.expectedRenter !== undefined && opts.expectedRenter !== renterPubkey) {
    throw new Error("rental payer identity changed — leases apply to the receipt signer's own requests");
  }
  const config = loadConfig();
  requireRehearsalNetwork(config.network, config.endpoints.tao);

  requireExpectedPayer(pair.address, opts.expectedPayer);
  if (opts.forEvent !== undefined && !/^[0-9a-f]{64}$/.test(opts.forEvent)) throw new Error("request id must be 64-hex");
  const maxAmountRao = opts.maxAmount === undefined ? undefined : parseAmount(opts.maxAmount, 9, "TAO").raw;
  if (maxAmountRao !== undefined && maxAmountRao <= 0n) throw new Error("maximum amount must be greater than zero");

  const announces = await marketQuery(relayUrl, { kinds: [47000], authors: [minerPk], limit: 20 });
  const offer = offerFromAnnounces(announces, minerPk);
  const quote = opts.expectedQuote;
  if (quote && (quote.payTo !== offer.payTo || quote.rateTaoHr !== offer.taoHr || (quote.offerId !== undefined && quote.offerId !== offer.offerId))) {
    throw new Error("rental quote changed — review the latest offer and approve again");
  }
  const rawAmount = Math.round(hours * offer.taoHr * 1e9);
  if (!Number.isSafeInteger(rawAmount)) throw new Error("lease amount is outside the supported range");
  const amountRao = BigInt(rawAmount);
  if (maxAmountRao !== undefined && amountRao > maxAmountRao) throw new Error("lease amount exceeds the approved maximum amount");
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
  let receiptId: string | undefined;
  let receiptError: string | undefined;
  let receiptPublished = false;
  try {
    const receipt = buildReceipt({
      agentSecretHex: nostrKey,
      payeePubkey: minerPk,
      ...(opts.forEvent ? { forEvent: opts.forEvent } : {}),
      amount: { raw: netRao, decimals: 9, symbol: "TAO" },
      chain: "tao", network: config.network, txHash, blockRef, memo: "lease",
    });
    receiptId = receipt.id;
    await marketPublish(relayUrl, receipt as SignedEvent);
    receiptPublished = true;
  } catch (error) {
    receiptError = error instanceof Error ? error.message : "receipt publication failed";
  }
  return {
    persona, miner: minerPk, hours, amount: formatRao(amountRao), ...(feeRao > 0n ? { fee: formatRao(feeRao) } : {}),
    payerAddress: pair.address, renterPubkey, payTo: offer.payTo, rateTaoHr: offer.taoHr, offerId: offer.offerId, network: "test",
    paidHours: hours * Number(netRao) / Number(amountRao), ...(opts.forEvent ? { forEvent: opts.forEvent } : {}),
    txHash, receiptId, receiptPublished, ...(receiptError ? { receiptError } : {}),
  };
}

export interface PayResult { persona: string; payerAddress: string; network: "test"; to: string; amount: string; fee?: string; txHash: string; receiptId?: string }

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
  opts: { forEvent?: string; payeePk?: string; relayUrl?: string; memo?: string; expectedPayer?: string } = {}
): Promise<PayResult> {
  requireWalletMutationAllowed();
  if (!isTaoAddress(to)) throw new Error("recipient must be a checksummed ss58 address");
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  requireRehearsalNetwork(config.network, config.endpoints.tao);
  requireExpectedPayer(pair.address, opts.expectedPayer);
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
  return { persona, payerAddress: pair.address, network: "test", to, amount: formatRao(amountRao), ...(feeRao > 0n ? { fee: formatRao(feeRao) } : {}), txHash, receiptId };
}
