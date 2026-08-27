/**
 * What the operator view needs to know, derived from relay events alone.
 *
 * Pure, so it is testable without a relay — the same split fez-wallet uses.
 * The view answers a different question from the public board at
 * bazaar.fez.chat: not "how is the market doing" but "how are MY workers
 * doing in it".
 */

export interface RawEvent {
  pubkey?: string;
  content: string;
  tags?: string[][];
}

export interface MinerRow {
  /** True for the single highest-scoring miner — the one the notch marks. */
  leading: boolean;
  pk: string;
  name: string;
  picture?: string;
  alive: boolean;
  lastSeen?: number;
  answered: number;
  tasksScored: number;
  avgTotal: number;
  bestRank?: number;
  /** Undefined when the miner does not report it — NOT zero. A miner that
   *  publishes no spend figure has not spent nothing. */
  earned?: number;
  spentUsd?: number;
}

/** A miner announces every five minutes; three misses and it is not alive. */
const HEARTBEAT_WINDOW_MS = 15 * 60_000;

/**
 * The freshest announce a miner has published.
 *
 * Kind 47000 is NOT replaceable — NIP-01 reserves 10000-19999 for that, and
 * 47000 sits outside it — so a relay keeps every announce a miner ever sent,
 * not just its latest. Taking the first match returns an arbitrary old one,
 * which renders as a live miner that is "not seen recently" with nothing
 * answered and nothing spent.
 */
export function latestAnnounce(announces: RawEvent[], pk: string): Beat | undefined {
  let best: Beat | undefined;
  for (const e of announces) {
    if (e.pubkey !== pk) continue;
    const beat = parse<Beat>(e.content);
    if (!beat) continue;
    if (best === undefined || (beat.heartbeat ?? 0) > (best.heartbeat ?? 0)) best = beat;
  }
  return best;
}

interface Beat {
  heartbeat?: number;
  answered?: number;
  earned?: number;
  spentUsd?: number;
}

const parse = <T,>(content: string | undefined): T | undefined => {
  if (!content) return undefined;
  try {
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
};

export function aliveWithin(
  lastSeen: number | undefined,
  now: number,
  windowMs: number = HEARTBEAT_WINDOW_MS,
): boolean {
  if (lastSeen === undefined) return false;
  return now - lastSeen * 1000 <= windowMs;
}

export function minerRows(opts: {
  profiles: RawEvent[];
  announces: RawEvent[];
  results: RawEvent[];
  attestations: RawEvent[];
  myPks: readonly string[];
  now: number;
}): MinerRow[] {
  const { profiles, announces, results, attestations, myPks, now } = opts;

  const rows = myPks.map((pk): MinerRow => {
    const prof = parse<{ name?: string; picture?: string }>(
      profiles.find((e) => e.pubkey === pk)?.content,
    );
    const beat = latestAnnounce(announces, pk);

    const scores = attestations
      .filter((e) => e.tags?.some((t) => t[0] === "p" && t[1] === pk))
      .map((e) => parse<{ total?: number; rank?: number }>(e.content))
      .filter((s): s is { total?: number; rank?: number } => s !== undefined);

    const totals = scores.map((s) => s.total ?? 0);
    const ranks = scores.map((s) => s.rank).filter((r): r is number => typeof r === "number");

    return {
      leading: false,   // assigned after the sort — only one row can lead
      pk,
      name: prof?.name ?? pk.slice(0, 8),
      picture: prof?.picture,
      alive: aliveWithin(beat?.heartbeat, now),
      lastSeen: beat?.heartbeat,
      // The heartbeat is authoritative — it counts every task the miner has
      // answered, while the relay only holds what it still has.
      answered: beat?.answered ?? results.filter((e) => e.pubkey === pk).length,
      tasksScored: totals.length,
      avgTotal: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0,
      bestRank: ranks.length ? Math.min(...ranks) : undefined,
      earned: beat?.earned,
      spentUsd: beat?.spentUsd,
    };
  });

  rows.sort((a, b) => b.avgTotal - a.avgTotal);
  // Exactly one leader, and only when someone has actually been judged.
  // `bestRank === 1` means "won a round once", which several miners can be.
  const top = rows[0];
  if (top && top.tasksScored > 0) top.leading = true;
  return rows;
}

/** One line of plain status, so a row reads without decoding numbers. */
export function statusLine(row: MinerRow): string {
  const parts: string[] = [row.alive ? "alive" : "not seen recently"];
  parts.push(`answered ${row.answered}`);
  if (row.tasksScored > 0) {
    parts.push(`judged ${row.tasksScored}×`, `mean ${row.avgTotal.toFixed(2)}`);
    if (row.bestRank !== undefined) parts.push(`best #${row.bestRank}`);
  } else {
    parts.push("not yet judged");
  }
  return parts.join(" · ");
}
