import { describe, expect, it } from "vitest";
import {
  completionDecision, completionQuestions, governCompletion,
  governThread, governorDecision, governorQuestions, governorState,
} from "../../fez-acp/src/governor.js";
import type { JudgeResult } from "../../fez-orchestrator/src/typesafe.js";

const nouls = (values: Record<string, number>): JudgeResult => ({
  model: "jev-1.13.0", inputTokens: 10, outputTokens: 3,
  answers: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: "noul", noul: v }])),
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
    const verdict = await governThread(async () => nouls({ needs_me: 0.1, resolved: 0.2, contradiction: 0.0 }), "drift", ["quill: thanks!"]);
    expect(verdict).toMatchObject({ outcome: "skip", values: { needs_me: 0.1, resolved: 0.2, contradiction: 0 } });
    expect(typeof verdict.latencyMs).toBe("number");
  });
  it("fails open: a judge error runs the turn as before", async () => {
    const verdict = await governThread(async () => { throw new Error("Judge HTTP 503"); }, "drift", ["quill: thanks!"]);
    expect(verdict.outcome).toBe("run");
    expect(verdict.error).toContain("503");
  });
});

describe("completionDecision", () => {
  it.each([
    [{ satisfies: 0.95, owner_needs_more: 0.1 }, "accept"],
    [{ satisfies: 0.95, owner_needs_more: 0.5 }, "run"],
    [{ satisfies: 0.8, owner_needs_more: 0.1 }, "run"],
    [{ satisfies: 0.86, owner_needs_more: 0.1 }, "accept"],
    [{ satisfies: 0.3, owner_needs_more: 0.9 }, "run"],
  ])("%o → %s", (values, outcome) => {
    expect(completionDecision(values).outcome).toBe(outcome);
  });
});

describe("governCompletion", () => {
  it("sends brief, result and thread as state and names both agents", async () => {
    let seen: { state: unknown; questions: Record<string, unknown> } | undefined;
    const verdict = await governCompletion(async (state, questions) => { seen = { state, questions }; return nouls({ satisfies: 0.97, owner_needs_more: 0.05 }); },
      "drift", "quill", "summarize X in two sentences", "X is ... Y is ...", ["Raleigh: @drift ...", "drift: @quill ...", "quill: X is ... Y is ..."]);
    expect(verdict.outcome).toBe("accept");
    expect(seen?.state).toMatchObject({ brief: "summarize X in two sentences", result: "X is ... Y is ..." });
    expect((seen?.state as { thread: string[] }).thread).toHaveLength(3);
    expect(Object.keys(seen!.questions)).toEqual(["satisfies", "owner_needs_more"]);
    expect(JSON.stringify(completionQuestions("drift", "quill"))).toContain("quill");
  });
  it("fails open to the full completion turn on a judge error", async () => {
    const verdict = await governCompletion(async () => { throw new Error("Judge HTTP 504"); }, "drift", "quill", "b", "r", []);
    expect(verdict.outcome).toBe("run");
    expect(verdict.error).toContain("504");
  });
});
