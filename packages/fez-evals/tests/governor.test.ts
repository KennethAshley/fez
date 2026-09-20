import { describe, expect, it } from "vitest";
import { governThread, governorDecision, governorQuestions, governorState } from "../../fez-acp/src/governor.js";
import type { JudgeResult } from "../../fez-orchestrator/src/typesafe.js";

const result = (values: { needs_me: number; resolved: number; contradiction: number }): JudgeResult => ({
  model: "jev-1.13.0", inputTokens: 10, outputTokens: 3,
  answers: {
    needs_me: { type: "noul", noul: values.needs_me },
    resolved: { type: "noul", noul: values.resolved },
    contradiction: { type: "noul", noul: values.contradiction },
  },
});

describe("governorDecision", () => {
  it.each([
    [{ needs_me: 0.9, resolved: 0.1, contradiction: 0.1 }, "run"],
    [{ needs_me: 0.2, resolved: 0.1, contradiction: 0.1 }, "skip"],
    [{ needs_me: 0.9, resolved: 0.9, contradiction: 0.1 }, "skip"],
    [{ needs_me: 0.9, resolved: 0.1, contradiction: 0.9 }, "escalate"],
    [{ needs_me: 0.2, resolved: 0.9, contradiction: 0.9 }, "escalate"],
    [{ needs_me: 0.5, resolved: 0.5, contradiction: 0.5 }, "run"],
  ])("%o → %s", (values, outcome) => {
    expect(governorDecision(values).outcome).toBe(outcome);
  });
});

describe("governorQuestions", () => {
  it("asks three nouls that name the agent", () => {
    const q = governorQuestions("drift");
    expect(Object.keys(q)).toEqual(["needs_me", "resolved", "contradiction"]);
    for (const question of Object.values(q)) expect(question.type).toBe("noul");
    expect(JSON.stringify(q.needs_me)).toContain("drift");
  });
});

describe("governorState", () => {
  it("keeps the most recent lines within the character budget", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `agent${i}: ${"x".repeat(3000)}`);
    const state = governorState(lines, 8000);
    expect(state.thread.length).toBeLessThan(10);
    expect(state.thread.at(-1)).toBe(lines.at(-1));
    expect(state.thread.join("\n").length).toBeLessThanOrEqual(8000);
  });
  it("always keeps the trigger line even when it alone exceeds the budget", () => {
    const state = governorState(["a: " + "y".repeat(500)], 100);
    expect(state.thread).toHaveLength(1);
  });
});

describe("governThread", () => {
  it("returns the decision with the raw values for calibration logging", async () => {
    const verdict = await governThread(async () => result({ needs_me: 0.1, resolved: 0.2, contradiction: 0.0 }), "drift", ["quill: thanks!"]);
    expect(verdict).toMatchObject({ outcome: "skip", values: { needs_me: 0.1, resolved: 0.2, contradiction: 0 } });
    expect(typeof verdict.latencyMs).toBe("number");
  });
  it("fails open: a judge error runs the turn as before", async () => {
    const verdict = await governThread(async () => { throw new Error("Judge HTTP 503"); }, "drift", ["quill: thanks!"]);
    expect(verdict.outcome).toBe("run");
    expect(verdict.error).toContain("503");
  });
});
