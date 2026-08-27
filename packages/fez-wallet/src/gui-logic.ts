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
export function receiptLine(
  r: ParsedReceipt,
  state: "verified" | "unverifiable" | "false"
): string | undefined {
  if (!isRenderableReceipt(r)) return undefined;
  const amount = formatAmount({ raw: r.raw, decimals: 9, symbol: r.symbol });
  const who = `${r.payer.slice(0, 8)}…`;
  // `chain` and `network` are separate tags — test and finney are BOTH
  // chain "tao", so the filter above passes play money through to the
  // same line as real money. Qualify the amount, never the mainnet one:
  // the badge means "not real", so its absence has to mean "real".
  const money = r.network === "finney" ? "" : ` · ${networkLabel(r.network)}`;
  const suffix =
    state === "verified"
      ? ""
      : state === "unverifiable"
        ? " · couldn't check this block"
        : " · ⚠️ the chain does not match this receipt";
  return `⚡ ${amount}${money} · ${who}${suffix}`;
}

export function requestStatus(
  reactions: { content: string; authorPk: string }[],
  ownerPk: string,
  msgTs: number,
  now: number
): "pending" | "approved" | "declined" | "expired" {
  for (const r of reactions) {
    if (r.authorPk !== ownerPk) continue;
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
