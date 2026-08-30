import path from "node:path";
import os from "node:os";
import type { WalletPair, EvmPair } from "./derive.js";
import { pairFromStored, evmPairFromStored } from "./derive.js";
import { readEntry, readAgentNostrKey } from "./store.js";
import { isValidEntryName, isReservedEntryName } from "./entry-names.js";
import { type WalletConfig, thresholdFor, loadConfig, rememberPayee, saveConfig, x402Settings } from "./config.js";
import { appendLog, readLog, appendX402Log } from "./log.js";
import { type ChainAdapter, parseAmount, formatAmount } from "./chains/adapter.js";
import { evmAdapter } from "./chains/evm.js";
import { buildConsentRequest, awaitDecision, poolRelay, type ConsentRelay } from "./consent.js";
import { mirrorSpend, mirrorEndpoint, mirrorX402Spend, mirrorX402Meta } from "./storage-mirror.js";
import type { Resolved } from "./resolve.js";
import { buildReceipt, parseReceipt, KIND_PAYMENT_RECEIPT } from "./receipt.js";
import {
  decodePaymentRequired,
  pickOffer,
  offerUsd,
  todaySpend,
  recordSpend,
  payWith402,
  parseSettlementHeader,
} from "./x402.js";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";

export const CONSENT_TIMEOUT_MS = 600_000; // 10 minutes

let endpointMirrored = false;

export interface ToolDeps {
  persona: string;
  pair: WalletPair;
  adapters: ChainAdapter[];
  config: WalletConfig;
  ownerPk?: string;
  relay?: () => Promise<ConsentRelay>;
  agentNostrKey?: string;
  /** Injected by mcp.ts's relay-backed resolver; defaults to resolveTo
   * (local-only) when no relay is configured — the CLI and every
   * pre-existing test never set this. */
  resolve?: (to: string) => Promise<Resolved>;
  now?: () => string; // test seam; defaults to wall clock
  /** Cancellation from the MCP request (finding #6) — checked before the
   * transfer actually fires so a harness timeout can't leave a spend
   * in flight after the caller has given up on the call. */
  signal?: AbortSignal;
}

function adapterFor(deps: ToolDeps, chain?: string, asset?: string): ChainAdapter {
  const c = deps.adapters.find(
    (a) => (chain ? a.chain === chain : true) && (asset ? a.assets.some((x) => x.symbol === asset) : true)
  );
  if (!c) throw new Error(`no enabled chain matches ${chain ?? asset ?? "(any)"}`);
  return c;
}

/** A `to` that names a local persona (store entry exists) resolves to that
 * persona's address; anything else passes through as a raw address — the
 * chain is the validator of address shape.
 *
 * `to` is agent-controlled, so it is checked against the entry-name rules
 * BEFORE ever touching the store (finding #1a): a name that isn't a legal
 * entry name, or that names the reserved mnemonic entry, is never looked
 * up — it just falls through untouched as a literal raw address, same as
 * any other string the store doesn't recognize as a persona. This is the
 * only way a `wallet_send` call naming the reserved entry is kept from
 * ever reading the mnemonic. */
function resolveTo(to: string): string {
  if (!isValidEntryName(to) || isReservedEntryName(to)) return to;
  const stored = readEntry(to);
  return stored ? pairFromStored(stored).address : to;
}

/**
 * One line, whatever the agent handed us. The consent card is a security
 * surface: `memo` and `to` are agent-controlled and land inside a message
 * the gui parses line-by-line, so a memo carrying newlines injects extra
 * lines that render as the card's own NOTES — the slot the wallet uses for
 * "network could not be checked". A forged "network verified: finney"
 * sitting among genuine notes is dressing on a real amount and a real
 * destination, and dressing is what a card is read for.
 *
 * Display only. The transfer still uses the verbatim address: an address
 * with whitespace in it is not a valid SS58 and never reaches the chain.
 */
function oneLine(s: string): string {
  return s.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
}

export function walletAddress(deps: ToolDeps, args: { chain?: string }): string {
  const a = adapterFor(deps, args.chain);
  return `${deps.persona} receive address (${a.chain}): ${a.address(deps.pair)}`;
}

export async function walletBalance(deps: ToolDeps, args: { chain?: string; asset?: string }): Promise<string> {
  const a = adapterFor(deps, args.chain, args.asset);
  const asset = args.asset ?? a.assets[0].symbol;
  const b = await a.balance(a.address(deps.pair), asset);
  return `${deps.persona} balance: ${formatAmount(b)}`;
}

export async function walletSend(
  deps: ToolDeps,
  args: { to: string; amount: string; asset: string; memo?: string; for?: string }
): Promise<string> {
  const a = adapterFor(deps, undefined, args.asset);
  const decimals = a.assets.find((x) => x.symbol === args.asset)!.decimals;
  const amount = parseAmount(args.amount, decimals, args.asset);

  // resolveTo stays as the local-only fallback for callers that inject no
  // resolver (the CLI, and every existing test).
  const resolved: Resolved = deps.resolve
    ? await deps.resolve(args.to)
    : { address: resolveTo(args.to), via: "local" };
  const to = resolved.address;

  // Before anything is signed: the guard that keeps a play session from
  // touching real TAO. A raw address announces no network and cannot be
  // checked — the consent card below says so in as many words (spec §8)
  // rather than letting an unchecked destination look checked.
  if (resolved.network && resolved.network !== deps.config.network) {
    throw new Error(
      `you're on ${deps.config.network}, ${args.to} is on ${resolved.network} — nothing was sent`
    );
  }

  // The envelope speaks first — no consent round-trip for money that isn't there.
  const balance = await a.balance(a.address(deps.pair), args.asset);
  if (balance.raw < amount.raw) {
    throw new Error(`insufficient balance: have ${formatAmount(balance)}, need ${formatAmount(amount)}`);
  }

  const threshold = parseAmount(thresholdFor(deps.config, deps.persona), decimals, args.asset);
  // The threshold answers "how much". A payee you have never paid raises
  // "to whom", which no amount can answer — so the first payment to a
  // given pubkey shows a card whatever its size, and only the first.
  const newPayee =
    resolved.payeePubkey !== undefined && !deps.config.knownPayees.includes(resolved.payeePubkey);
  const needsConsent = amount.raw > threshold.raw || newPayee;
  let consent: "auto" | "approved" = "auto";
  if (needsConsent) {
    if (!deps.relay || !deps.ownerPk || !deps.agentNostrKey || !deps.config.consentChannel) {
      throw new Error(
        "this amount needs owner consent, but the consent channel is not configured (set consentChannel in wallet.json)"
      );
    }
    const relay = await deps.relay();
    const request = buildConsentRequest({
      agentSecretHex: deps.agentNostrKey,
      channelId: deps.config.consentChannel,
      ownerPk: deps.ownerPk,
      // Rendered as a channel message — amount up front, and the FULL
      // address: what the owner approves must be the address that gets
      // paid, verbatim. The gui card does the shortening for display.
      text: [
        ...(newPayee ? ["first payment to this agent"] : []),
        // Spec §8: an unknowable network is stated, never implied safe.
        // Note lines sit ABOVE the 💸 line and the card renders them as
        // its own notes (gui-logic's parseConsentRequest).
        ...(resolved.network === undefined
          ? [`network could not be checked — this address publishes none (you are on ${deps.config.network})`]
          : []),
        `💸 **${deps.persona}** wants to send **${formatAmount(amount)}**`,
        `to \`${oneLine(to)}\`${args.memo ? ` — ${oneLine(args.memo)}` : ""}`,
        `react ✅ to approve · ❌ to decline`,
      ].join("\n"),
    });
    // Subscribe BEFORE publishing so a fast reaction can't slip past.
    const decision = awaitDecision(relay, request.id, deps.ownerPk, CONSENT_TIMEOUT_MS, deps.signal);
    await relay.publish(request);
    const verdict = await decision;
    if (verdict !== "approved") {
      const reason =
        verdict === "timeout"
          ? "declined (consent timed out after 10 minutes)"
          : verdict === "aborted"
            ? "declined (request was aborted)"
            : "declined by owner";
      return `send ${reason} — nothing was transferred`;
    }
    consent = "approved";
  }

  // Re-checked right before the transfer fires (finding #6): a caller that
  // aborted while waiting on consent — or even one that never needed
  // consent at all — must not have money move on their way out the door.
  if (deps.signal?.aborted) {
    return "send declined (request was aborted) — nothing was transferred";
  }

  const { txHash, blockRef } = await a.transfer(deps.pair, to, amount);
  const entry = {
    ts: deps.now ? deps.now() : new Date().toISOString(),
    persona: deps.persona,
    to,
    amount: args.amount,
    asset: args.asset,
    txHash,
    memo: args.memo,
    consent,
    network: deps.config.network,
  };
  appendLog(entry);
  void mirrorSpend(entry);
  // Remembered only after money actually moved, and only on approval: a
  // decline, a timeout, or a transfer that threw must never mark this
  // pubkey known — that would spend the new-payee card on a payment that
  // never happened and wave the NEXT one straight through.
  if (consent === "approved" && resolved.payeePubkey) {
    rememberPayee(deps.config, resolved.payeePubkey);
    saveConfig(deps.config);
  }
  if (!endpointMirrored) {
    endpointMirrored = true;
    const config = loadConfig();
    void mirrorEndpoint(config.endpoints.tao, config.network);
  }

  let receiptNote = "";
  if (args.for && deps.relay && deps.agentNostrKey) {
    try {
      const relay = await deps.relay();
      await relay.publish(
        buildReceipt({
          agentSecretHex: deps.agentNostrKey,
          forEvent: args.for,
          payeePubkey: resolved.payeePubkey,
          channelId: deps.config.consentChannel,
          amount,
          chain: a.chain,
          network: deps.config.network,
          txHash,
          blockRef,
          memo: args.memo,
        })
      );
    } catch {
      // The money moved; the note about it did not. Two separate facts,
      // and a failed event must never provoke a retried transfer.
      receiptNote = " (the receipt failed to publish — the transfer stands)";
    }
  }

  return `sent ${formatAmount(amount)} → ${to} (tx ${txHash}${consent === "approved" ? ", owner-approved" : ""})${receiptNote}`;
}

export async function walletHistory(deps: ToolDeps, args: { limit?: number }): Promise<string> {
  const limit = args.limit ?? 20;
  const rows = readLog(deps.config.network, limit)
    .filter((r) => r.persona === deps.persona)
    .map((r) => `- ${r.ts} · ${r.amount} ${r.asset} → ${r.to}${r.memo ? ` (${r.memo})` : ""} · ${r.consent} · ${r.txHash}`);

  const inbound: string[] = [];
  if (deps.relay && deps.agentNostrKey) {
    try {
      const relay = await deps.relay();
      const me = getPublicKey(hexToBytes(deps.agentNostrKey));
      const events = await relay.query({ kinds: [KIND_PAYMENT_RECEIPT], "#p": [me], limit });
      for (const ev of events) {
        const r = parseReceipt(ev);
        if (!r || r.network !== deps.config.network) continue;
        // A receipt names its own chain and asset, and the decimals have to
        // come from THAT pair — rendering everything at TAO's 9 misprints
        // an 18-decimal asset by nine orders of magnitude. A pair this
        // wallet has no adapter for is skipped rather than guessed at: a
        // wrong number in a wallet is a wrong number.
        const decimals = deps.adapters
          .find((x) => x.chain === r.chain)
          ?.assets.find((s) => s.symbol === r.symbol)?.decimals;
        if (decimals === undefined) continue;
        // Not verified here: verification costs a chain round-trip per
        // row. Unverified is stated, never implied — an inbound row is
        // never counted as settled on the strength of the event alone.
        inbound.push(
          `- ${new Date(ev.created_at * 1000).toISOString()} · ${formatAmount({ raw: r.raw, decimals, symbol: r.symbol })} ← from ${r.payer.slice(0, 12)}… · (unverified)`
        );
      }
    } catch {
      // A relay that won't answer costs you the inbound half, not the call.
    }
  }

  const all = [...rows, ...inbound];
  return all.length ? all.join("\n") : "no transfers recorded.";
}

/** evmPairFromStored's error never echoes the input (it's the same
 * generic-error contract as pairFromStored) — which also means it never
 * says WHY the read failed. The one common cause is an entry derived
 * before EVM existed (T1/T2), and that has a fix an agent can act on. */
export function resolveEvmPair(persona: string, stored: string): EvmPair {
  try {
    return evmPairFromStored(stored);
  } catch {
    throw new Error(`no EVM account for "${persona}" — re-run: fez-wallet derive ${persona} to add an EVM account`);
  }
}

/** Structurally just enough of the Fetch API for x402Fetch to work against
 * — real global `fetch` satisfies this; tests hand in a plain async
 * function instead of standing up a Response. */
export type FetchLike = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface X402ToolDeps {
  persona: string;
  evmPair: EvmPair;
  /** The evm ChainAdapter — used only for the best-effort balance check. */
  adapter: ChainAdapter;
  config: WalletConfig;
  ownerPk?: string;
  relay?: () => Promise<ConsentRelay>;
  agentNostrKey?: string;
  /** Directory the spend tally (x402.ts) and the x402 log (log.ts) live
   * in — same seam both already use, so tests never touch FEZ_WALLET_HOME. */
  dir: string;
  fetchImpl?: FetchLike;
  now?: () => string;
  signal?: AbortSignal;
}

const BODY_PREVIEW_BYTES = 2048;
/** Hard ceiling on how much of a response body the structured outcome
 * (`X402Outcome`) retains — generous enough for any JSON body a paid
 * service returns, small enough that a runaway response can't balloon
 * memory. The string-tool's own display still truncates far tighter, at
 * BODY_PREVIEW_BYTES, exactly as before this refactor. */
const RAW_BODY_MAX_BYTES = 64 * 1024;

async function readBody(res: {
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}): Promise<{ contentType: string; bodyText: string }> {
  const contentType = res.headers.get("content-type") ?? "unknown";
  const bodyText = (await res.text()).slice(0, RAW_BODY_MAX_BYTES);
  return { contentType, bodyText };
}

/**
 * The structured result of one x402Fetch attempt — `x402Fetch` (below) is
 * a thin string formatter over this. "paid" and "ambiguous" are both
 * post-payment: "paid" means a settlement transaction hash came back,
 * "ambiguous" means a payment was signed and dispatched but whether it
 * landed can no longer be told from this response alone (a network
 * failure, a second 402, a non-2xx, or no valid settlement header) —
 * never retry either kind.
 */
export type X402Outcome =
  | { kind: "response"; status: number; contentType: string; bodyText: string }
  | {
      kind: "paid";
      status: number;
      contentType: string;
      bodyText: string;
      bodyUnreadable?: boolean;
      txHash: string;
      usd: number;
      payTo: string;
      receiptNote?: string;
      balanceNote?: string;
    }
  | { kind: "refused"; message: string }
  | { kind: "ambiguous"; message: string; usd: number; txHash?: string };

/**
 * The agent's own x402 client, structured core: fetch a URL, and if (and
 * only if) the server answers 402, pay for it — behind the exact same
 * policy shape as `walletSend` (caps, consent, record-before-retry) plus
 * x402's OWN invariant: a payment is signed and tallied AT MOST ONCE per
 * call, no matter what the paid retry comes back with. `recordSpend`/the
 * "signed" log row land BEFORE the paid retry is even sent (finding:
 * never let a network hiccup after signing look like "nothing happened"
 * — a second call would just pay twice).
 *
 * Every guard, ordering decision, and side effect (mirrors, logs, the
 * consent round-trip, the receipt publish) lives here, unchanged from
 * before this was split out of `x402Fetch`.
 */
export async function x402FetchRaw(
  deps: X402ToolDeps,
  args: { url: string; method?: string; body?: string; maxUsd: number }
): Promise<X402Outcome> {
  if (typeof args.maxUsd !== "number" || !(args.maxUsd > 0)) {
    throw new Error("x402_fetch requires maxUsd — the most you're willing to pay for this call");
  }
  // M5: http(s)-only. This closes off file:/data:/gopher: etc — it does
  // NOT block private/internal targets (127.0.0.1, the cloud metadata
  // address, RFC1918 ranges): that SSRF surface is a deliberate scope cut
  // for this pass, since every URL here is one the calling agent chose
  // itself rather than one relayed from an untrusted third party.
  try {
    const scheme = new URL(args.url).protocol;
    if (scheme !== "http:" && scheme !== "https:") throw new Error("bad scheme");
  } catch {
    throw new Error(`x402_fetch: "${args.url}" is not an http(s) URL`);
  }
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const x402 = x402Settings(deps.config);
  // The panel is a read-only view: mirror the resolved settings (for the
  // balance call + display) and every ledger row, beside the on-disk log.
  void mirrorX402Meta({
    network: x402.network,
    rpcUrl: x402.rpcUrl,
    usdcAddress: x402.usdcAddress,
    dailyCapUsd: x402.dailyCapUsd,
    autoApproveDefault: x402.autoApproveUnderUsd.default ?? 0,
  });
  const logX402 = (entry: Parameters<typeof appendX402Log>[1]) => {
    appendX402Log(deps.dir, entry);
    void mirrorX402Spend(entry);
  };
  const now = () => (deps.now ? deps.now() : new Date().toISOString());
  const init = { method: args.method ?? "GET", ...(args.body !== undefined ? { body: args.body } : {}) };

  const first = await fetchImpl(args.url, init);
  if (first.status !== 402) {
    const { contentType, bodyText } = await readBody(first);
    return { kind: "response", status: first.status, contentType, bodyText };
  }

  const header = first.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("x402_fetch: got a 402 with no PAYMENT-REQUIRED header");
  const required = decodePaymentRequired(header);
  const offer = pickOffer(required.accepts, { network: x402.chainRef, usdcAddress: x402.usdcAddress, v1Network: x402.network });
  if (!offer) {
    const seen = required.accepts.map((o) => `${o.scheme}/${o.network}/${o.asset}`).join(", ") || "(none)";
    return { kind: "refused", message: `refused: the 402 offered nothing that matches ${x402.chainRef}/${x402.usdcAddress} — offers seen: ${seen}` };
  }
  // M1: a payTo that isn't a plain 20-byte hex address is either a
  // malformed offer or an attempt to dress up the consent card (a
  // backtick, a bidi character, anything the card would render verbatim)
  // — refused before it ever reaches the consent text or a signature.
  if (!/^0x[0-9a-fA-F]{40}$/.test(offer.payTo)) {
    return { kind: "refused", message: `refused: the offer's payTo "${offer.payTo}" is not a valid EVM address — nothing was paid` };
  }
  const usd = offerUsd(offer);

  if (usd > args.maxUsd) {
    return { kind: "refused", message: `refused: this costs $${usd.toFixed(2)}, above your maxUsd of $${args.maxUsd.toFixed(2)} — nothing was paid` };
  }
  const spentToday = todaySpend(deps.dir);
  if (spentToday + usd > x402.dailyCapUsd) {
    return {
      kind: "refused",
      message: `refused: paying $${usd.toFixed(2)} would push today's spend past the $${x402.dailyCapUsd.toFixed(2)} daily cap (already spent $${spentToday.toFixed(2)}) — nothing was paid`,
    };
  }

  // Best-effort: the envelope speaks first when it can be checked at all,
  // but an unreachable RPC must not block a payment the other checks
  // already cleared — it's noted on the way out instead.
  let balanceNote = "";
  try {
    const balance = await deps.adapter.balance(deps.evmPair.addressHex, "USDC");
    const usdBalance = Number(balance.raw) / 10 ** balance.decimals;
    if (usdBalance < usd) {
      return { kind: "refused", message: `refused: balance is $${usdBalance.toFixed(2)} USDC, below the $${usd.toFixed(2)} price — nothing was paid` };
    }
  } catch {
    balanceNote = " (balance unverified — RPC unreachable)";
  }

  const autoApprove = x402.autoApproveUnderUsd[deps.persona] ?? x402.autoApproveUnderUsd.default;
  const needsConsent = usd > autoApprove;
  if (needsConsent) {
    if (!deps.relay || !deps.ownerPk || !deps.agentNostrKey || !deps.config.consentChannel) {
      throw new Error(
        "this payment needs owner consent, but the consent channel is not configured (set consentChannel in wallet.json)"
      );
    }
    const relay = await deps.relay();
    const request = buildConsentRequest({
      agentSecretHex: deps.agentNostrKey,
      channelId: deps.config.consentChannel,
      ownerPk: deps.ownerPk,
      text: [
        `💸 **${deps.persona}** wants to pay **$${usd.toFixed(2)} USDC**`,
        `to \`${oneLine(offer.payTo)}\` for \`${oneLine(args.url)}\``,
        `react ✅ to approve · ❌ to decline`,
      ].join("\n"),
    });
    // Subscribe BEFORE publishing so a fast reaction can't slip past.
    const decision = awaitDecision(relay, request.id, deps.ownerPk, CONSENT_TIMEOUT_MS, deps.signal);
    await relay.publish(request);
    const verdict = await decision;
    if (verdict !== "approved") {
      const reason =
        verdict === "timeout"
          ? "consent timed out after 10 minutes"
          : verdict === "aborted"
            ? "request was aborted"
            : "declined by owner";
      return { kind: "refused", message: `nothing was paid — ${reason}` };
    }
  }

  // Re-checked right before anything is signed (mirrors walletSend): a
  // caller that aborted while waiting on consent — or one that never
  // needed consent at all — must not have money move on its way out.
  if (deps.signal?.aborted) {
    return { kind: "refused", message: "nothing was paid — request was aborted" };
  }

  // SIGN FIRST. A signing refusal is unambiguous, not ambiguous: nothing
  // has left this process (no header was sent anywhere), so it costs
  // nothing and needs none of the "may have settled" wording below. This
  // is also the boundary the restricted signer actually defends — a
  // server-steerable offer (e.g. `extra.assetTransferMethod: "permit2"`,
  // routing the SDK into a primitive our signer refuses) must be caught
  // HERE, before any tally or log write exists to roll back.
  let paymentHeaders: Record<string, string>;
  try {
    ({ paymentHeaders } = await payWith402({
      offer,
      privateKeyHex: deps.evmPair.privateKeyHex,
      usdcAddress: x402.usdcAddress,
      x402Version: required.x402Version,
    }));
  } catch (e) {
    return { kind: "refused", message: `nothing was paid — the payment could not be signed (${(e as Error).message})` };
  }

  // Record-before-DISPATCH: THE invariant this tool exists to enforce.
  // recordSpend both tallies AND enforces the daily cap in one
  // synchronous call (no `await` inside it) — the earlier pre-check
  // above is only a consent-round-saver; THIS is what actually closes
  // the race between two overlapping calls (see x402.ts's recordSpend).
  // If the cap throws here, the authorization just signed is inert: it
  // never left this process and cannot settle, so refusing costs
  // nothing and is not ambiguous either — same as the signing-refusal
  // branch above.
  try {
    recordSpend(deps.dir, usd, x402.dailyCapUsd);
  } catch (e) {
    return { kind: "refused", message: `nothing was paid — ${(e as Error).message}` };
  }
  logX402({
    ts: now(),
    persona: deps.persona,
    url: args.url,
    payTo: offer.payTo,
    usd,
    status: "signed",
    network: x402.network,
  });

  let paidRes: Awaited<ReturnType<FetchLike>>;
  try {
    paidRes = await fetchImpl(args.url, { ...init, headers: { ...paymentHeaders } });
  } catch (e) {
    logX402({
      ts: now(),
      persona: deps.persona,
      url: args.url,
      payTo: offer.payTo,
      usd,
      status: "ambiguous",
      network: x402.network,
    });
    return {
      kind: "ambiguous",
      usd,
      message:
        `a payment was signed but the paid request failed to complete (${(e as Error).message}) — ` +
        `it may have settled. Do NOT retry — check receipts and the spend log.${balanceNote}`,
    };
  }

  if (paidRes.status === 402 || paidRes.status < 200 || paidRes.status >= 300) {
    logX402({
      ts: now(),
      persona: deps.persona,
      url: args.url,
      payTo: offer.payTo,
      usd,
      status: "ambiguous",
      network: x402.network,
    });
    return {
      kind: "ambiguous",
      usd,
      message:
        paidRes.status === 402
          ? `the server demanded payment again after a payment was already signed — NOT retrying (it may have settled); check receipts and the spend log.${balanceNote}`
          : `the paid request returned HTTP ${paidRes.status} — it may have settled; do not retry, check receipts and the spend log.${balanceNote}`,
    };
  }

  // C1: nothing from here down may throw uncaught — the payment already
  // landed (2xx). @x402/core's settlement decoder throws on a malformed
  // PAYMENT-RESPONSE (a hostile or buggy server), and Response#text() can
  // throw too; either one throwing here, unguarded, would reject the
  // whole call with NO settled row, NO receipt, and NO "do not retry"
  // wording — inviting exactly the double-pay this tool exists to
  // prevent. Both are now WHAT-HAPPENED failures, never WAS-IT-PAID ones.
  let settlement: Awaited<ReturnType<typeof parseSettlementHeader>>;
  try {
    settlement = parseSettlementHeader(paidRes.headers);
  } catch {
    settlement = undefined;
  }
  const txHash = settlement?.transaction ?? "";

  let contentType = "unknown";
  let bodyText = "";
  let bodyUnreadable = false;
  try {
    ({ contentType, bodyText } = await readBody(paidRes));
  } catch {
    bodyUnreadable = true;
  }

  // M2: an empty/missing txHash means the server said 2xx but never told
  // us how to verify it — that is NOT "settled". Logged ambiguous, and no
  // receipt is published: a receipt with an empty ["tx", ""] tag names no
  // verifiable transaction (receipt.ts's parseReceipt would reject it),
  // so publishing it would only dress up an unresolved payment as a real
  // audit entry.
  if (!txHash) {
    logX402({
      ts: now(),
      persona: deps.persona,
      url: args.url,
      payTo: offer.payTo,
      usd,
      status: "ambiguous",
      network: x402.network,
    });
    const summary = bodyUnreadable
      ? `HTTP ${paidRes.status} (body unreadable)`
      : `HTTP ${paidRes.status} (${contentType})\n${bodyText.slice(0, BODY_PREVIEW_BYTES)}`;
    return {
      kind: "ambiguous",
      usd,
      message:
        `${summary}\na payment was signed and the server answered ${paidRes.status}, but no valid settlement header ` +
        `came back — it may have settled. Do NOT retry — check receipts and the spend log.${balanceNote}`,
    };
  }

  logX402({
    ts: now(),
    persona: deps.persona,
    url: args.url,
    payTo: offer.payTo,
    usd,
    status: "settled",
    txHash,
    network: x402.network,
  });

  let receiptNote = "";
  if (deps.relay && deps.agentNostrKey) {
    try {
      const relay = await deps.relay();
      await relay.publish(
        buildReceipt({
          agentSecretHex: deps.agentNostrKey,
          channelId: deps.config.consentChannel,
          amount: { raw: BigInt(offer.amount ?? offer.maxAmountRequired ?? "0"), decimals: 6, symbol: "USDC" },
          chain: "base",
          network: x402.network,
          txHash,
          memo: args.url,
        })
      );
    } catch {
      receiptNote = " (the receipt failed to publish — the payment stands)";
    }
  }

  return {
    kind: "paid",
    status: paidRes.status,
    contentType,
    bodyText,
    bodyUnreadable,
    txHash,
    usd,
    payTo: offer.payTo,
    receiptNote,
    balanceNote,
  };
}

/**
 * The agent's own x402 client: fetch a URL, and if (and only if) the
 * server answers 402, pay for it. A thin string formatter over
 * `x402FetchRaw` — every reply below is built purely from the returned
 * outcome's fields, so this tool's wording is unchanged by that split.
 */
export async function x402Fetch(
  deps: X402ToolDeps,
  args: { url: string; method?: string; body?: string; maxUsd: number }
): Promise<string> {
  const outcome = await x402FetchRaw(deps, args);
  switch (outcome.kind) {
    case "response":
      return `HTTP ${outcome.status} (${outcome.contentType})\n${outcome.bodyText.slice(0, BODY_PREVIEW_BYTES)}`;
    case "refused":
    case "ambiguous":
      return outcome.message;
    case "paid": {
      const summary = outcome.bodyUnreadable
        ? `HTTP ${outcome.status} (body unreadable)`
        : `HTTP ${outcome.status} (${outcome.contentType})\n${outcome.bodyText.slice(0, BODY_PREVIEW_BYTES)}`;
      return `${summary}\npaid $${outcome.usd.toFixed(2)} USDC → ${outcome.payTo}, tx ${outcome.txHash}${outcome.receiptNote ?? ""}${outcome.balanceNote ?? ""}`;
    }
  }
}

const evmAdaptersByKey = new Map<string, ChainAdapter>();
function cachedEvmAdapter(rpcUrl: string, usdcAddress: string): ChainAdapter {
  const key = `${rpcUrl}|${usdcAddress}`;
  let a = evmAdaptersByKey.get(key);
  if (!a) {
    a = evmAdapter({ rpcUrl, usdcAddress });
    evmAdaptersByKey.set(key, a);
  }
  return a;
}

/**
 * Builds real `X402ToolDeps` for `persona` — the same construction mcp.ts
 * uses to run `x402_fetch` for real, extracted here so a sibling package
 * (e.g. fez-ridges) can build the identical deps and call `x402FetchRaw`
 * directly, without importing mcp.ts itself (which has top-level side
 * effects: it reads FEZ_AGENT_PERSONA from the environment and connects
 * an MCP stdio server on load — never safe to import as a library).
 */
export async function makeX402Deps(persona: string, signal?: AbortSignal): Promise<X402ToolDeps> {
  const stored = readEntry(persona);
  if (!stored) {
    throw new Error(`no wallet for "${persona}" — run: fez-wallet derive ${persona}`);
  }
  const config = loadConfig();
  const settings = x402Settings(config);
  const relays = (process.env.FEZ_RELAY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const agentNostrKey = readAgentNostrKey(persona);
  return {
    persona,
    evmPair: resolveEvmPair(persona, stored),
    adapter: cachedEvmAdapter(settings.rpcUrl, settings.usdcAddress),
    config,
    ownerPk: process.env.FEZ_AGENT_OWNER,
    agentNostrKey,
    relay: relays.length ? () => poolRelay(relays, agentNostrKey) : undefined,
    dir: process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez"),
    signal,
  };
}
