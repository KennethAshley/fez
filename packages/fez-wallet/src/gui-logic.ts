/** Pure logic for the wallet gui part — node-testable, no React. */
import type { Network } from "./storage-mirror.js";
import type { SpendEntry } from "./log.js";

export function parseConsentRequest(
  content: string
): { persona: string; amount: string; to: string; memo?: string } | undefined {
  const lines = content.split("\n");
  if (lines.length < 3) return undefined;
  const head = /^💸 \*\*(.+)\*\* wants to send \*\*(.+)\*\*$/.exec(lines[0]);
  const dest = /^to `([^`]+)`(?: — (.+))?$/.exec(lines[1]);
  if (!head || !dest || !lines[2].startsWith("react ✅")) return undefined;
  return { persona: head[1], amount: head[2], to: dest[1], ...(dest[2] ? { memo: dest[2] } : {}) };
}

const APPROVE = new Set(["✅", "+"]);
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

/** Same shape parseAmount accepts, checked before it reaches the wallet:
 * a decimal with at most TAO's 9 places. */
export function validThreshold(text: string): boolean {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  return !!m && (m[2]?.length ?? 0) <= 9;
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
