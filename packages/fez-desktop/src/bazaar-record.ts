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

export function aggregateRecord(events: AttestationEvent[]): RecordRow[] {
  const byType = new Map<string, { count: number; pcts: number[]; lastAt: number }>();
  for (const ev of events) {
    if (!BAZAAR_VALIDATORS.includes(ev.pubkey)) continue;
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
