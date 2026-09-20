/**
 * Owner-question gate. Smaller models hand presentation choices back to
 * the owner — "technical or accessible?", "what tone?" — each one a
 * blocking prompt and, on pi, a minute of dead time. Before an owner
 * question posts, the judge scores one statement: is this only about
 * how the agent words, formats, or sizes its own output? High = the
 * agent decides (its own recommended option), and nothing posts.
 *
 * Deliberately narrow: it never touches questions about what is done,
 * for whom, when, at what cost or risk. Wording checked live 2026-09-20:
 * presentation questions 0.88–0.94, real owner decisions ≤ 0.06, an
 * audience question 0.24. Fails open — any judge problem asks as before.
 */
import type { JudgeQuestion, JudgeResult } from "../../fez-orchestrator/src/typesafe.js";

export const STYLE_ONLY_AT = 0.8;

export interface GateOption { label: string; recommended?: boolean }
export interface GateVerdict {
  outcome: "ask" | "self";
  /** The option the agent should take when deciding itself: its recommendation, else the first. */
  pick: string;
  value?: number;
  latencyMs: number;
  error?: string;
}

export function presentationQuestion(): Record<"style", JudgeQuestion> {
  return {
    style: {
      type: "noul",
      instructions: {
        question: "Is `ask` only about how to word, phrase, format, structure, or size something the agent is itself producing — wording, tone, register, length, layout, bullets versus prose?",
      },
      criteria: {
        true: "Any answer produces the same substance; it changes only presentation of the agent's own output.",
        false: "The answer changes what is done, for whom, when, at what cost or risk, or depends on facts about the owner's situation the agent cannot know.",
      },
    },
  };
}

export function pickFor(options: GateOption[]): string {
  return (options.find((o) => o.recommended) ?? options[0]).label;
}

export async function gateOwnerQuestion(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  question: string,
  options: GateOption[],
): Promise<GateVerdict> {
  const startedAt = Date.now();
  const pick = pickFor(options);
  try {
    const result = await ask({ ask: { question, options: options.map((o) => o.label + (o.recommended ? " (recommended)" : "")) } }, presentationQuestion());
    const answer = result.answers.style;
    if (answer?.type !== "noul") throw new Error("owner gate: missing noul");
    return { outcome: answer.noul >= STYLE_ONLY_AT ? "self" : "ask", pick, value: answer.noul, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: "ask", pick, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}
