import type { WalletPair } from "./derive.js";
import { pairFromStored } from "./derive.js";
import { readEntry } from "./store.js";
import { isValidEntryName, isReservedEntryName } from "./entry-names.js";
import { type WalletConfig, thresholdFor, loadConfig } from "./config.js";
import { appendLog, readLog } from "./log.js";
import { type ChainAdapter, parseAmount, formatAmount } from "./chains/adapter.js";
import { buildConsentRequest, awaitDecision, type ConsentRelay } from "./consent.js";
import { mirrorSpend, mirrorEndpoint } from "./storage-mirror.js";

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
  args: { to: string; amount: string; asset: string; memo?: string }
): Promise<string> {
  const a = adapterFor(deps, undefined, args.asset);
  const decimals = a.assets.find((x) => x.symbol === args.asset)!.decimals;
  const amount = parseAmount(args.amount, decimals, args.asset);
  const to = resolveTo(args.to);

  // The envelope speaks first — no consent round-trip for money that isn't there.
  const balance = await a.balance(a.address(deps.pair), args.asset);
  if (balance.raw < amount.raw) {
    throw new Error(`insufficient balance: have ${formatAmount(balance)}, need ${formatAmount(amount)}`);
  }

  const threshold = parseAmount(thresholdFor(deps.config, deps.persona), decimals, args.asset);
  let consent: "auto" | "approved" = "auto";
  if (amount.raw > threshold.raw) {
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
      // Rendered as a channel message — short lines, truncated address,
      // the amount up front. The full address matters less than the
      // amount and reason; anyone auditing has the chain.
      text: [
        `💸 **${deps.persona}** wants to send **${formatAmount(amount)}**`,
        `to \`${to.length > 16 ? `${to.slice(0, 8)}…${to.slice(-6)}` : to}\`${args.memo ? ` — ${args.memo}` : ""}`,
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

  const { txHash } = await a.transfer(deps.pair, to, amount);
  const entry = {
    ts: deps.now ? deps.now() : new Date().toISOString(),
    persona: deps.persona,
    to,
    amount: args.amount,
    asset: args.asset,
    txHash,
    memo: args.memo,
    consent,
  };
  appendLog(entry);
  void mirrorSpend(entry);
  if (!endpointMirrored) {
    endpointMirrored = true;
    const config = loadConfig();
    void mirrorEndpoint(config.endpoints.tao);
  }
  return `sent ${formatAmount(amount)} → ${to} (tx ${txHash}${consent === "approved" ? ", owner-approved" : ""})`;
}

export function walletHistory(deps: ToolDeps, args: { limit?: number }): string {
  const rows = readLog(args.limit ?? 20).filter((r) => r.persona === deps.persona);
  if (rows.length === 0) return "no transfers recorded.";
  return rows
    .map((r) => `- ${r.ts} · ${r.amount} ${r.asset} → ${r.to}${r.memo ? ` (${r.memo})` : ""} · ${r.consent} · ${r.txHash}`)
    .join("\n");
}
