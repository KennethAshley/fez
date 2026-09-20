/**
 * Judged conditions for workflows — the deterministic skeleton stays;
 * Jev answers the yes/no questions inside it. Pure helpers here (tested
 * from fez-evals); workflows.ts wires them to the gateway.
 *
 * Every judgment is a noul: a statement about the state, answered with
 * the probability it is true. Definitions threshold explicitly with the
 * existing expression language (`judge.blocker >= 0.8`), so nothing is
 * hidden: the value lands in the run trace and in a variable.
 */
import type { JudgeQuestion, JudgeResult } from "../../fez-orchestrator/src/typesafe.js";

export interface JudgeConfig { url: string; key: string }
export type Ask = (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>;

/** Default bar for `when:` triggers and `wait_until` steps when `at:` is omitted. */
export const DEFAULT_AT = 0.8;

export function judgeConfigFromEnv(env: Record<string, string | undefined>): JudgeConfig | undefined {
  const url = env.FEZ_JUDGE_URL?.trim();
  const key = env.FEZ_JUDGE_KEY?.trim();
  return url && key ? { url, key } : undefined;
}

/** A map of name → statement becomes a map of name → noul question over the same state. */
export function nouls(statements: Record<string, string>): Record<string, JudgeQuestion> {
  return Object.fromEntries(Object.entries(statements).map(([name, statement]) => [name, {
    type: "noul",
    instructions: { statement, question: "Is `statement` true of the content in the state?" },
  } satisfies JudgeQuestion]));
}

/** Ask every statement in one call; returns name → probability. Throws on judge failure (callers fail loudly, then open). */
export async function judgeStatements(ask: Ask, state: unknown, statements: Record<string, string>): Promise<Record<string, number>> {
  const result = await ask(state, nouls(statements));
  const values: Record<string, number> = {};
  for (const name of Object.keys(statements)) {
    const answer = result.answers[name];
    if (answer?.type !== "noul") throw new Error(`judge: no noul answer for "${name}"`);
    values[name] = answer.noul;
  }
  return values;
}

/** Flatten judged values into expression variables: {"judge.blocker": 0.12}. */
export function judgeVars(values: Record<string, number>, prefix = "judge"): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`${prefix}.${name}`, value]));
}

/** What a workflow judgment sees: the trigger text and the latest thread message the run has observed. */
export function judgeState(vars: Record<string, string | number | boolean>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (vars["trigger.text"] !== undefined) state.trigger = { author: vars["trigger.author_name"], text: vars["trigger.text"] };
  if (vars["latest.text"] !== undefined) state.latest = { author: vars["latest.author_name"], text: vars["latest.text"] };
  return { ...state, ...extra };
}
