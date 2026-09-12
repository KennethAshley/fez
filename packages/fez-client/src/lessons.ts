/** Lessons remain ordinary private engrams; this prefix opts into candidate recall. */
export const LESSON_PREFIX = "mem/lessons/";

export interface CandidateLesson {
  when: string;
  action: string;
  evidence: string;
  source: string;
}

/** Validate the record, not its truth: evidence and source are still the agent's claims. */
export function parseLesson(value: unknown): CandidateLesson | undefined {
  if (typeof value !== "string" || value.length > 14_000) return;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  const field = (name: string, max: number): string | undefined => {
    const text = record[name];
    return typeof text === "string" && text.trim() && text.length <= max ? text.trim() : undefined;
  };
  const when = field("when", 400), action = field("action", 4000);
  const evidence = field("evidence", 4000), source = field("source", 1000);
  if (when && action && evidence && source) return { when, action, evidence, source };
}
