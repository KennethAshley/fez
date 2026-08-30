import { type Network, endpointForUnchecked, isNetworkOwnedEndpoint } from "./networks.js";
/** Pure logic for the wallet gui part — node-testable, no React. */
import type { SpendEntry } from "./log.js";
import type { ParsedReceipt } from "./receipt.js";
import { formatAmount } from "./chains/adapter.js";

/**
 * The 💸 line need not be the FIRST line: walletSend prepends note lines
 * ("first payment to this agent", "network could not be checked …") that
 * the owner has to see before deciding. An anchored-at-zero parser
 * dropped the card for exactly the requests that most needed one, so the
 * head is located rather than assumed, and anything that isn't head,
 * destination or the react footer comes back as `notes` for the card to
 * render.
 */
export function parseConsentRequest(
  content: string
): { persona: string; amount: string; to: string; memo?: string; notes?: string[] } | undefined {
  const lines = content.split("\n");
  const i = lines.findIndex((l) => /^💸 \*\*(.+)\*\* wants to send \*\*(.+)\*\*$/.test(l));
  if (i < 0 || lines.length < i + 3) return undefined;
  const head = /^💸 \*\*(.+)\*\* wants to send \*\*(.+)\*\*$/.exec(lines[i])!;
  const dest = /^to `([^`]+)`(?: — (.+))?$/.exec(lines[i + 1]);
  const footer = lines.findIndex((l, n) => n > i + 1 && l.startsWith("react ✅"));
  if (!dest || footer < 0) return undefined;
  const notes = lines.filter((l, n) => n !== i && n !== i + 1 && n !== footer && l.trim() !== "");
  return {
    persona: head[1],
    amount: head[2],
    to: dest[1],
    ...(dest[2] ? { memo: dest[2] } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** ✅ ONLY — the same set consent.ts authorizes on, and for the same
 * reason: NIP-25's "+" is the generic like, so a stock nostr client's
 * like/ack button would move money. The panel must not show "approved"
 * for a reaction the wallet would not have spent on. Decline stays wide:
 * a stray decline costs nothing, a stray approval costs TAO. */
const APPROVE = new Set(["✅"]);
const DECLINE = new Set(["❌", "-"]);
const WINDOW_S = 600;

/**
 * A receive-address line, wherever it sits in the message. The strict
 * contract ("<persona> receive address (chain): <addr>") lasted one live
 * round: agents paraphrase tool output ("My TAO receive address:
 * `5Dq6…`"), so the parser accepts any line carrying the phrase plus an
 * address-shaped token. WHO the address belongs to is not parsed from
 * text at all — the card takes it from the message's author, which the
 * caller has already verified. Backticks are display, not data.
 */
export function parseReceiveAddress(content: string): { chain: string; address: string } | undefined {
  for (const raw of content.split("\n")) {
    const line = raw.replace(/`/g, "");
    if (!/receive address/i.test(line)) continue;
    const address = /[1-9A-HJ-NP-Za-km-z]{40,60}/.exec(line)?.[0];
    if (!address) continue;
    const chain = /\(([^)]+)\)/.exec(line)?.[1].toLowerCase() ?? "tao";
    return { chain, address };
  }
  return undefined;
}

/** Reverse the address book: who is this address? Accepts the full
 * address or a `head…tail` truncated display form. */
export function personaFor(
  shown: string,
  book: { treasury?: string; personas?: Record<string, string> }
): string | undefined {
  const entries: [string, string][] = [
    ...(book.treasury ? ([["treasury", book.treasury]] as [string, string][]) : []),
    ...Object.entries(book.personas ?? {}),
  ];
  const hit = entries.find(([, addr]) => {
    if (addr === shown) return true;
    const cut = shown.indexOf("…");
    if (cut <= 0 || cut === shown.length - 1) return false;
    return addr.startsWith(shown.slice(0, cut)) && addr.endsWith(shown.slice(cut + 1));
  });
  return hit?.[0];
}

/** The ledger entry a consent request produced, if it has landed:
 * same persona and recipient, numerically the same amount, timestamped
 * at or after the request. Newest wins — the ledger appends. */
export function matchSpend(
  req: { persona: string; amount: string; to: string },
  msgTs: number,
  log: { ts: string; persona: string; to: string; amount: string; asset: string; txHash: string }[]
): { txHash: string } | undefined {
  const reqNum = parseFloat(req.amount);
  const toMatches = (to: string) => {
    if (to === req.to) return true;
    const cut = req.to.indexOf("…");
    if (cut <= 0 || cut === req.to.length - 1) return false;
    return to.startsWith(req.to.slice(0, cut)) && to.endsWith(req.to.slice(cut + 1));
  };
  return [...log]
    .reverse()
    .find(
      (e) =>
        e.persona === req.persona &&
        toMatches(e.to) &&
        parseFloat(e.amount) === reqNum &&
        req.amount.endsWith(e.asset) &&
        Date.parse(e.ts) / 1000 >= msgTs
    );
}

/**
 * SS58 addresses loose in a chat message — for the taostats/copy chip
 * row. Bittensor addresses are base58 and start with "5" (ss58 prefix
 * 42); the lookarounds refuse tokens embedded in longer base58-legal
 * runs, which is what keeps 64-char hex pubkeys out. Fenced code blocks
 * are stripped (pasted logs and tool source aren't payment surfaces);
 * inline backticks need no handling — a backtick already breaks the
 * token boundary. First-seen order, deduped, capped at five.
 */
export function extractAddresses(content: string): string[] {
  const prose = content.replace(/```[\s\S]*?```/g, " ");
  const seen: string[] = [];
  for (const m of prose.matchAll(/(?<![1-9A-HJ-NP-Za-km-z])5[1-9A-HJ-NP-Za-km-z]{39,49}(?![1-9A-HJ-NP-Za-km-z])/g)) {
    if (!seen.includes(m[0])) seen.push(m[0]);
    if (seen.length === 5) break;
  }
  return seen;
}

/** Countdown text for a pending card; undefined once the window is spent. */
export function remainingText(msgTs: number, now: number): string | undefined {
  const left = WINDOW_S - (now - msgTs);
  if (left <= 0) return undefined;
  const mins = Math.floor(left / 60);
  return mins >= 1 ? `expires in ${mins}m` : "expires in <1m";
}

/** The one network's rows the panel shows — never both at once (the
 * whole point of splitting the ledger). A network that hasn't been
 * mirrored yet falls back to "finney": never guess a testnet is live. */
export function logsFor(
  logs: Partial<Record<Network, SpendEntry[]>> | undefined,
  network: Network | undefined
): SpendEntry[] {
  return (logs ?? {})[network ?? "finney"] ?? [];
}

/** The panel's mainnet tell: anything that isn't finney gets "play money"
 * stamped next to it, so the settings screen is never the place someone
 * mistakes a testnet transfer for a real one. */
export function networkLabel(network: string): string {
  return network === "finney" ? "finney (mainnet)" : `${network} — play money`;
}

/**
 * The panel edits ONE key of the thresholds object — `default` — and
 * every other key belongs to somebody else: `thresholdFor` reads a
 * per-persona threshold, and migratePrefs moved wallet.json's into
 * prefs. Writing `{ default: next }` wholesale deleted them, and the
 * harm ran the wrong way: a persona deliberately held to a TIGHTER
 * threshold fell back to the looser default, so MORE money auto-sent
 * with no consent card. Merge, never replace. (The panel still shows
 * only `default`; the rest it preserves without displaying.)
 */
export function mergeThresholds(
  existing: Record<string, string> | undefined,
  next: string
): Record<string, string> {
  return { ...(existing ?? {}), default: next };
}

/** Same shape parseAmount accepts, checked before it reaches the wallet:
 * a decimal with at most TAO's 9 places. */
export function validThreshold(text: string): boolean {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  return !!m && (m[2]?.length ?? 0) <= 9;
}

/** The only chain this panel knows the decimals for. A 47040 carries
 * whatever `chain` its author put on it, and TAO's 9 decimals applied to
 * an 18-decimal asset misprints the amount by nine orders of magnitude.
 * The gui holds no adapter list to ask, so an unknown chain is not
 * rendered at all — a missing row is honest, a wrong number is not. */
export function isRenderableReceipt(r: ParsedReceipt): boolean {
  return r.chain === "tao" && r.symbol === "TAO";
}

/** Three states, never two: a block we could not fetch is not a check
 * that failed, and collapsing them would call an honest receipt a lie.
 * `undefined` is a fourth thing entirely — "not ours to render". */

export function requestStatus(
  reactions: { content: string; authorPk: string; ts: number }[],
  ownerPk: string,
  msgTs: number,
  now: number
): "pending" | "approved" | "declined" | "expired" {
  for (const r of reactions) {
    if (r.authorPk !== ownerPk) continue;
    // Only decisions made INSIDE the consent window count. The wallet's
    // awaitDecision stopped listening when it closed and returned
    // "declined (timed out)" — it will transfer nothing — so reading a
    // late ✅ as approved leaves the card at "waiting for the transfer
    // to land…" forever, on a spend the wallet already refused.
    if (r.ts - msgTs > WINDOW_S) continue;
    if (APPROVE.has(r.content.trim())) return "approved";
    if (DECLINE.has(r.content.trim())) return "declined";
  }
  return now - msgTs > WINDOW_S ? "expired" : "pending";
}

/**
 * Which chain the panel should dial for balances.
 *
 * Derived from the SELECTED network, not from whatever was last mirrored:
 * prefs is the source of truth, so a selector set to `test` means the wallet
 * is on test from its next call onward, and a panel still reading the
 * previously-mirrored endpoint just shows the wrong chain until some other
 * process happens to write. The one exception mirrors loadConfig's rule
 * exactly — an UNRECOGNISED mirrored endpoint is a local node or a fork,
 * a genuine override the wallet itself will honour, so the panel must too.
 */
export function panelEndpoint(network: Network, mirrored: string | undefined): string | undefined {
  if (mirrored !== undefined && !isNetworkOwnedEndpoint(mirrored)) return mirrored;
  // `string | undefined`, not `string`: prefs is a file and can hold a
  // hand-edit or a value from a newer build, in which case there is no
  // endpoint to dial. Saying so in the type keeps the caller's guard
  // visibly load-bearing rather than looking like dead code.
  return endpointForUnchecked(network);
}

/**
 * Which network the panel is showing. This MUST mirror loadConfig's
 * precedence (config.ts): prefs, then what the wallet last resolved, then
 * the conservative default.
 *
 * The middle leg is the one that is easy to drop and expensive to lose. A
 * wallet written before prefs existed records its network only as a pinned
 * endpoint; loadConfig infers from that pin, and the mirrored value IS that
 * resolved answer. A panel reading prefs alone therefore labels such a
 * wallet "finney (mainnet)" while every payment it makes goes out on test.
 */
export function resolveNetwork(
  prefs: string | undefined,
  mirrored: Network | undefined
): string {
  return prefs ?? mirrored ?? "finney";
}

/**
 * A ledger row's timestamp. Entries store an ISO string, and printing it
 * raw put "2026-08-27T17:01:37.089Z" in a table column — unreadable, and
 * wide enough to wrap onto two lines. What you scan a ledger for is the
 * day and the minute; the exact instant stays available on hover.
 *
 * Unparseable input comes back untouched rather than blank: the money
 * moved either way, and a row that hides its own time is worse than one
 * showing something odd.
 */
export function ledgerTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const day = at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time}`;
}

/**
 * The amount, on its own, for a card that shows it as a headline rather
 * than inside a sentence. A chain whose decimals this panel does not
 * know renders NOTHING: printing TAO's 9 against an 18-decimal asset is
 * wrong by nine orders of magnitude, and a missing row is honest where a
 * wrong number is not.
 */
export function receiptAmount(r: ParsedReceipt): string | undefined {
  if (!isRenderableReceipt(r)) return undefined;
  return formatAmount({ raw: r.raw, decimals: 9, symbol: r.symbol });
}

/**
 * The play-money badge. `chain` and `network` are separate tags on a
 * 47040 — test and finney are BOTH chain "tao" — so nothing about the
 * amount distinguishes them, and a testnet payment used to render
 * identically to a real one. Mainnet is deliberately unlabelled: the
 * badge means "not real", so its ABSENCE is what has to carry "real",
 * and stamping "finney (mainnet)" on every honest payment would be the
 * same bug wearing the opposite coat.
 */
export function playMoneyBadge(network: string): string | undefined {
  return network === "finney" ? undefined : networkLabel(network);
}

/**
 * Three states, never two: a block we could not fetch is not a check
 * that failed, and collapsing them would call an honest receipt a lie.
 */
export function receiptStateText(state: "verified" | "unverifiable" | "false"): string {
  if (state === "verified") return "verified on chain";
  if (state === "unverifiable") return "couldn't check this block";
  return "\u26a0 the chain does not match this receipt";
}

/* ── x402 / USDC (browser-safe helpers for the panel) ──────────────── */

/** balanceOf(holder) calldata for a read-only eth_call — the one RPC the
 * panel makes. Display-only: a wrong balance shows a wrong number, it
 * cannot move money (spending resolves its own settings node-side). */
export function erc20BalanceCall(usdcAddress: string, holder: string): { to: string; data: string } {
  const addr = holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return { to: usdcAddress, data: `0x70a08231${addr}` };
}

/** Hex eth_call result → dollars ("5.00"), 6-decimal USDC. undefined on
 * junk rather than "0.00" — an unreadable balance is not a zero balance. */
export function parseUsdcBalance(hexResult: string): string | undefined {
  if (!/^0x[0-9a-fA-F]*$/.test(hexResult)) return undefined;
  let raw: bigint;
  try {
    raw = BigInt(hexResult === "0x" ? "0x0" : hexResult);
  } catch {
    return undefined;
  }
  const cents = raw / 10_000n; // 6 decimals → cents
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Money-shaped text: non-negative decimal, at most 2dp not enforced —
 * the settings inputs accept what Number() + the node-side finite guard
 * accept, minus signs and garbage. */
export function validUsd(text: string): boolean {
  return /^\d+(\.\d+)?$/.test(text.trim()) && Number.isFinite(Number(text));
}

/** DISPLAY-ONLY mirror of config.ts's X402_NETWORK_TABLE explorer hosts.
 * Drift here mislinks a tx page, never a payment. */
export function x402TxLink(network: string, txHash: string): string {
  const host = network === "base" ? "https://basescan.org" : "https://sepolia.basescan.org";
  return `${host}/tx/${txHash}`;
}

/** The two networks the panel's selector offers — mirrors config.ts's
 * table keys; adding a row there means adding it here for the GUI. */
export const X402_NETWORKS = ["base-sepolia", "base"] as const;

export function x402NetworkLabel(network: string): string {
  return network === "base" ? "base (REAL USDC)" : "base-sepolia (test USDC)";
}

/** DISPLAY-ONLY mirror of config.ts's network table (that module imports
 * node:fs and cannot enter the browser bundle). Drift here shows a wrong
 * balance or mislinks an explorer page — it cannot move money: spends
 * resolve their own settings node-side from config.ts's table. */
export const X402_DISPLAY: Record<string, { rpcUrl: string; usdcAddress: string }> = {
  "base-sepolia": { rpcUrl: "https://sepolia.base.org", usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  base: { rpcUrl: "https://mainnet.base.org", usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
};
