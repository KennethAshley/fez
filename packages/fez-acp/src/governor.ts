/**
 * Thread governor: before a fellow agent's message costs a harness turn,
 * ask the judge a few yes/no questions about the thread and decide
 * whether the turn is worth running. Pure logic here; agent.ts wires it
 * to the relay and the judge. Fails open — any judge problem runs the
 * turn exactly as before, so the governor can only remove turns that
 * would have been noise, never block work.
 *
 * Two stages:
 *  - mention:    a plain sibling mention → run / skip / escalate
 *  - completion: a worker's successful result for work I assigned →
 *                accept (chit + one templated line, no model turn) / run
 */
import type { JudgeQuestion, JudgeResult } from "../../fez-orchestrator/src/typesafe.js";

export type GovernorOutcome = "run" | "skip" | "escalate";
export interface GovernorValues { needs_me: number; resolved: number; contradiction: number }
export interface GovernorVerdict {
  outcome: GovernorOutcome;
  reason: string;
  values?: GovernorValues;
  latencyMs: number;
  error?: string;
}

// ponytail: fixed thresholds from nothing but priors; every decision is
// logged with its raw values so these get calibrated from real traffic.
export const ESCALATE_AT = 0.8;
export const RESOLVED_AT = 0.8;
export const NEEDS_ME_BELOW = 0.3;
/** A direct request at or above this runs even in a thread the judge calls resolved. */
export const NEEDS_ME_DIRECT = 0.5;
/** State budget in characters — well under Jev's 32k-token state cap even for CJK. */
export const STATE_CHARS = 12_000;

export function governorQuestions(me: string): Record<"needs_me" | "resolved" | "contradiction", JudgeQuestion> {
  return {
    // Wording checked live 2026-09-20: a workflow's summons in an already
    // answered thread scored 0.66 under "require a substantive response"
    // and 0.91 under this; the skip/run scenarios were unchanged.
    needs_me: {
      type: "noul",
      instructions: { agent: me, question: "Does the latest message in `thread` ask `agent` to do, answer, or produce something?" },
      criteria: {
        true: "It addresses or names `agent` and requests an action, an answer, or a deliverable — even if the rest of the thread is already settled.",
        false: "It is an acknowledgment, thanks, a status note, or a message that asks nothing of `agent`.",
      },
    },
    resolved: {
      type: "noul",
      instructions: "Is the task or question in `thread` complete or decided, with no further agent action needed?",
    },
    contradiction: {
      type: "noul",
      instructions: "Do the last two agent messages in `thread` contradict each other on a matter of fact or a decision?",
    },
  };
}

/** Most recent lines that fit the budget; the trigger (last line) is always kept. */
export function governorState(lines: readonly string[], budget = STATE_CHARS): { thread: string[] } {
  const thread: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1;
    if (thread.length > 0 && used + cost > budget) break;
    thread.unshift(lines[i]);
    used += cost;
  }
  return { thread };
}

// "Resolved" describes the thread's ORIGINAL task. A follow-up that
// addresses this agent directly (a workflow's summons, a new question)
// lands in a resolved thread by design, so a direct request outranks it —
// found live when a workflow's "@quill one sentence please" was skipped.
export function governorDecision(values: GovernorValues): { outcome: GovernorOutcome; reason: string } {
  if (values.contradiction >= ESCALATE_AT) return { outcome: "escalate", reason: `contradiction ${values.contradiction.toFixed(2)}` };
  if (values.needs_me < NEEDS_ME_BELOW) return { outcome: "skip", reason: `no response needed ${values.needs_me.toFixed(2)}` };
  if (values.resolved >= RESOLVED_AT && values.needs_me < NEEDS_ME_DIRECT) return { outcome: "skip", reason: `thread resolved ${values.resolved.toFixed(2)}, needs me ${values.needs_me.toFixed(2)}` };
  return { outcome: "run", reason: `needs me ${values.needs_me.toFixed(2)}` };
}

function nouls<K extends string>(result: JudgeResult, names: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const name of names) {
    const answer = result.answers[name];
    if (answer?.type !== "noul") throw new Error(`governor: missing noul ${name}`);
    out[name] = answer.noul;
  }
  return out;
}

export async function governThread(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  me: string,
  lines: readonly string[],
): Promise<GovernorVerdict> {
  const startedAt = Date.now();
  try {
    const result = await ask(governorState(lines), governorQuestions(me));
    const values = nouls(result, ["needs_me", "resolved", "contradiction"] as const);
    return { ...governorDecision(values), values, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: "run", reason: "judge unavailable", latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error) };
  }
}

// ── completion stage ─────────────────────────────────────────────────

export type CompletionOutcome = "accept" | "run";
export interface CompletionValues { satisfies: number; owner_needs_more: number }
export interface CompletionVerdict {
  outcome: CompletionOutcome;
  reason: string;
  values?: CompletionValues;
  latencyMs: number;
  error?: string;
}

// ponytail: same story — priors, logged, calibrate later. Acceptance is
// the one place the judge makes a call the model used to make, so the
// bar is deliberately high and anything short of it runs the turn.
export const ACCEPT_AT = 0.85;
export const OWNER_NEEDS_MORE_BELOW = 0.3;

export function completionQuestions(me: string, worker: string): Record<"satisfies" | "owner_needs_more", JudgeQuestion> {
  return {
    // Wording chosen against five live cases (2026-09-20): substance-only
    // scored the two correct results 0.89/0.94 and every bad one ≤ 0.04;
    // wordings that let format count dragged a correct result to 0.57.
    satisfies: {
      type: "noul",
      instructions: {
        requester: me, worker,
        question: "Does `result` state every point `brief` asked `worker` to cover, consistent with the facts in `brief`?",
        ignore: "sentence count, headings, phrasing, and any extra correct detail",
      },
      criteria: {
        true: "All requested points are stated and match the brief's facts.",
        false: "A requested point is absent or contradicts the brief, or the worker asked a question or reported a blocker instead.",
      },
    },
    owner_needs_more: {
      type: "noul",
      instructions: "Does the person who originally asked (see the start of `thread`) still need information that is not already in `result`?",
    },
  };
}

export function completionDecision(values: CompletionValues): { outcome: CompletionOutcome; reason: string } {
  if (values.satisfies >= ACCEPT_AT && values.owner_needs_more < OWNER_NEEDS_MORE_BELOW) {
    return { outcome: "accept", reason: `satisfies ${values.satisfies.toFixed(2)}, owner needs more ${values.owner_needs_more.toFixed(2)}` };
  }
  return { outcome: "run", reason: `satisfies ${values.satisfies.toFixed(2)}, owner needs more ${values.owner_needs_more.toFixed(2)}` };
}

export async function governCompletion(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  me: string,
  worker: string,
  brief: string,
  result: string,
  lines: readonly string[],
): Promise<CompletionVerdict> {
  const startedAt = Date.now();
  try {
    const state = { brief: brief.slice(0, STATE_CHARS), result: result.slice(0, STATE_CHARS), ...governorState(lines) };
    const answers = await ask(state, completionQuestions(me, worker));
    const values = nouls(answers, ["satisfies", "owner_needs_more"] as const);
    return { ...completionDecision(values), values, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: "run", reason: "judge unavailable", latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error) };
  }
}
