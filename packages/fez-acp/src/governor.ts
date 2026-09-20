/**
 * Thread governor: before a fellow agent's mention costs a harness turn,
 * ask the judge three yes/no questions about the thread and decide
 * whether the turn is worth running. Pure logic here; agent.ts wires it
 * to the relay and the judge. Fails open — any judge problem runs the
 * turn exactly as before, so the governor can only remove turns that
 * would have been noise, never block work.
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
/** State budget in characters — well under Jev's 32k-token state cap even for CJK. */
export const STATE_CHARS = 12_000;

export function governorQuestions(me: string): Record<"needs_me" | "resolved" | "contradiction", JudgeQuestion> {
  return {
    needs_me: {
      type: "noul",
      instructions: { agent: me, question: "Does the latest message in `thread` require a substantive response from `agent`?" },
      criteria: {
        true: "It asks `agent` a question, assigns `agent` work, or reports something `agent` must act on.",
        false: "It is an acknowledgment, thanks, a status note, or a reply that closes the loop with nothing left for `agent` to do.",
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

export function governorDecision(values: GovernorValues): { outcome: GovernorOutcome; reason: string } {
  if (values.contradiction >= ESCALATE_AT) return { outcome: "escalate", reason: `contradiction ${values.contradiction.toFixed(2)}` };
  if (values.resolved >= RESOLVED_AT) return { outcome: "skip", reason: `thread resolved ${values.resolved.toFixed(2)}` };
  if (values.needs_me < NEEDS_ME_BELOW) return { outcome: "skip", reason: `no response needed ${values.needs_me.toFixed(2)}` };
  return { outcome: "run", reason: `needs me ${values.needs_me.toFixed(2)}` };
}

export async function governThread(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  me: string,
  lines: readonly string[],
): Promise<GovernorVerdict> {
  const startedAt = Date.now();
  try {
    const result = await ask(governorState(lines), governorQuestions(me));
    const noul = (name: keyof GovernorValues): number => {
      const answer = result.answers[name];
      if (answer?.type !== "noul") throw new Error(`governor: missing noul ${name}`);
      return answer.noul;
    };
    const values = { needs_me: noul("needs_me"), resolved: noul("resolved"), contradiction: noul("contradiction") };
    return { ...governorDecision(values), values, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: "run", reason: "judge unavailable", latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error) };
  }
}
