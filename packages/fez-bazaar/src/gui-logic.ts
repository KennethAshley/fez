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
  pk: string;
  name: string;
  picture?: string;
  alive: boolean;
  lastSeen?: number;
  answered: number;
  tasksScored: number;
  avgTotal: number;
  bestRank?: number;
  earned: number;
  spentUsd: number;
}

/** A miner announces every five minutes; three misses and it is not alive. */
const HEARTBEAT_WINDOW_MS = 15 * 60_000;

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
    const beat = parse<{
      heartbeat?: number;
      answered?: number;
      earned?: number;
      spentUsd?: number;
    }>(announces.find((e) => e.pubkey === pk)?.content);

    const scores = attestations
      .filter((e) => e.tags?.some((t) => t[0] === "p" && t[1] === pk))
      .map((e) => parse<{ total?: number; rank?: number }>(e.content))
      .filter((s): s is { total?: number; rank?: number } => s !== undefined);

    const totals = scores.map((s) => s.total ?? 0);
    const ranks = scores.map((s) => s.rank).filter((r): r is number => typeof r === "number");

    return {
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
      earned: beat?.earned ?? 0,
      spentUsd: beat?.spentUsd ?? 0,
    };
  });

  return rows.sort((a, b) => b.avgTotal - a.avgTotal);
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
