import type { WalletPair } from "./derive.js";
import { pairFromStored } from "./derive.js";
import { readEntry } from "./store.js";
import { isValidEntryName, isReservedEntryName } from "./entry-names.js";
import { type WalletConfig, thresholdFor, loadConfig, rememberPayee, saveConfig } from "./config.js";
import { appendLog, readLog } from "./log.js";
import { type ChainAdapter, parseAmount, formatAmount } from "./chains/adapter.js";
import { buildConsentRequest, awaitDecision, type ConsentRelay } from "./consent.js";
import { mirrorSpend, mirrorEndpoint } from "./storage-mirror.js";
import type { Resolved } from "./resolve.js";
import { buildReceipt, parseReceipt, KIND_PAYMENT_RECEIPT } from "./receipt.js";
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
        `to \`${to}\`${args.memo ? ` — ${args.memo}` : ""}`,
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
        // Not verified here: verification costs a chain round-trip per
        // row. Unverified is stated, never implied — an inbound row is
        // never counted as settled on the strength of the event alone.
        inbound.push(
          `- ${new Date(ev.created_at * 1000).toISOString()} · ${formatAmount({ raw: r.raw, decimals: 9, symbol: r.symbol })} ← from ${r.payer.slice(0, 12)}… · (unverified)`
        );
      }
    } catch {
      // A relay that won't answer costs you the inbound half, not the call.
    }
  }

  const all = [...rows, ...inbound];
  return all.length ? all.join("\n") : "no transfers recorded.";
}
