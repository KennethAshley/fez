/**
 * An agent's judged track record, aggregated from bazaar attestations
 * (47020). Pure — the relay read lives in the component; this is the part
 * with rules, so it is the part with tests.
 *
 * BAZAAR_VALIDATORS is a consumer-side allowlist by design (the relay is
 * dumb); source of truth: fez-bazaar src/protocol/validators.ts.
 */

export const BAZAAR_RELAY = "wss://bazaar.fez.chat";
export const BAZAAR_VALIDATORS = [
  "b7496a3167b5af5d1350375a4d231d1fc94d56cabb8d11dc586191b35985a37d",
];

export interface AttestationEvent {
  id: string; pubkey: string; kind: number; content: string;
  tags: string[][]; created_at: number;
}

export interface RecordRow {
  taskType: string;
  count: number;
  /** Mean of (cohort-rank)/(cohort-1), 0–100. Absent when no row carried a cohort. */
  percentile?: number;
  lastAt: number;
}

export function aggregateRecord(events: AttestationEvent[], pk: string): RecordRow[] {
  const byType = new Map<string, { count: number; pcts: number[]; lastAt: number }>();
  for (const ev of events) {
    if (!BAZAAR_VALIDATORS.includes(ev.pubkey)) continue;
    if (ev.kind !== 47020) continue;
    if (!ev.tags.some((t) => t[0] === "p" && t[1] === pk)) continue;
    let body: { rank?: number; cohort?: number };
    try { body = JSON.parse(ev.content) as never; } catch { continue; }
    const taskType = ev.tags.find((t) => t[0] === "task_type")?.[1] ?? "general";
    const g = byType.get(taskType) ?? { count: 0, pcts: [], lastAt: 0 };
    g.count++;
    g.lastAt = Math.max(g.lastAt, ev.created_at);
    if (typeof body.rank === "number" && typeof body.cohort === "number" && body.cohort > 1) {
      g.pcts.push((body.cohort - body.rank) / (body.cohort - 1));
    }
    byType.set(taskType, g);
  }
  return [...byType.entries()]
    .map(([taskType, g]) => ({
      taskType,
      count: g.count,
      percentile: g.pcts.length ? Math.round((g.pcts.reduce((a, b) => a + b, 0) / g.pcts.length) * 100) : undefined,
      lastAt: g.lastAt,
    }))
    .sort((a, b) => b.count - a.count);
}

/** Batch form: attestations for many agents, grouped by their p tag and
 * aggregated with the same rules (and the same rejections) as the single
 * form — one relay query serves a whole mention picker. */
export function aggregateRecordsByAgent(events: AttestationEvent[]): Map<string, RecordRow[]> {
  const byPk = new Map<string, AttestationEvent[]>();
  for (const ev of events) {
    const pk = ev.tags.find((t) => t[0] === "p")?.[1];
    if (!pk) continue;
    byPk.set(pk, [...(byPk.get(pk) ?? []), ev]);
  }
  return new Map([...byPk].map(([pk, evs]) => [pk, aggregateRecord(evs, pk)]));
}

/** One number for ranking a picker: -1 = no record, otherwise best
 * percentile weighted by evidence volume.
 * ponytail: naive blend (best pct × log2 of total tasks) — revisit the
 * formula when real records make the ordering look wrong. */
export function recordScore(rows: RecordRow[]): number {
  if (rows.length === 0) return -1;
  const best = Math.max(...rows.map((r) => r.percentile ?? 0));
  const count = rows.reduce((a, r) => a + r.count, 0);
  return best * Math.log2(count + 1);
}

/** The row a chip should show: the agent's strongest suit. */
export function bestRow(rows: RecordRow[]): RecordRow | undefined {
  return [...rows].sort((a, b) => (b.percentile ?? -1) - (a.percentile ?? -1) || b.count - a.count)[0];
}
