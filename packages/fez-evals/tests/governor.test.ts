import { describe, expect, it } from "vitest";
import {
  completionDecision, completionQuestions, governCompletion, silentAccept, governSteer, STATE_CHARS,
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
    [{ needs_me: 0.9, resolved: 0.9, contradiction: 0.1 }, "run"],
    [{ needs_me: 0.4, resolved: 0.9, contradiction: 0.1 }, "skip"],
    [{ needs_me: 0.4, resolved: 0.5, contradiction: 0.1 }, "run"],
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
  it("sends request, brief, result and thread as state; names both agents; carries the outcome label", async () => {
    let seen: { state: unknown; questions: Record<string, unknown> } | undefined;
    const verdict = await governCompletion(async (state, questions) => {
      seen = { state, questions };
      const r = nouls({ satisfies: 0.97, owner_needs_more: 0.05 });
      r.answers.outcome = { type: "choice", choice: "answered", confidence: 0.96, probabilities: { answered: 0.97, partial: 0.02, wrong: 0.01, deferred: 0 } };
      return r;
    }, "drift", "quill", "summarize X in two sentences", "X is ... Y is ...", "@drift what is X? hand it to quill for two sentences",
      ["Raleigh: @drift ...", "drift: @quill ...", "quill: X is ... Y is ..."]);
    expect(verdict.outcome).toBe("accept");
    expect(verdict.values?.outcome).toBe("answered");
    expect(seen?.state).toMatchObject({ request: "@drift what is X? hand it to quill for two sentences", brief: "summarize X in two sentences", result: "X is ... Y is ..." });
    expect((seen?.state as { thread: string[] }).thread).toHaveLength(3);
    expect(Object.keys(seen!.questions)).toEqual(["satisfies", "owner_needs_more", "outcome"]);
    expect(JSON.stringify(completionQuestions("drift", "quill"))).toContain("quill");
  });
  it("falls back to the brief as the request when the thread root is unavailable, and tolerates a missing outcome", async () => {
    let seen: unknown;
    const verdict = await governCompletion(async (state) => { seen = state; return nouls({ satisfies: 0.9, owner_needs_more: 0.1 }); }, "drift", "quill", "b", "r", undefined, []);
    expect(seen).toMatchObject({ brief: "b", result: "r", request: "b" });
    expect(verdict.outcome).toBe("accept");
    expect(verdict.values?.outcome).toBeUndefined();
  });
  it("fails open to the full completion turn on a judge error", async () => {
    const verdict = await governCompletion(async () => { throw new Error("Judge HTTP 504"); }, "drift", "quill", "b", "r", undefined, []);
    expect(verdict.outcome).toBe("run");
    expect(verdict.error).toContain("504");
  });
});

describe("governSteer", () => {
  const ask = (value: number) => async () => nouls({ changes_work: value });
  it("steers when the new message bears on the work in flight", async () => {
    const v = await governSteer(ask(0.91), "research the latest Bun release", "actually just the version number, skip the changelog");
    expect(v).toMatchObject({ outcome: "steer", value: 0.91 });
  });
  it("queues thanks and asides instead of throwing the turn away", async () => {
    const v = await governSteer(ask(0.05), "research the latest Bun release", "thanks!");
    expect(v.outcome).toBe("queue");
  });
  it("sends only the two texts, capped", async () => {
    let seen: unknown;
    await governSteer(async (state, questions) => { seen = { state, keys: Object.keys(questions) }; return nouls({ changes_work: 0.5 }); }, "a".repeat(20_000), "b");
    expect(seen).toMatchObject({ keys: ["changes_work"], state: { new_message: "b" } });
    expect(((seen as { state: { in_flight: string } }).state.in_flight).length).toBe(STATE_CHARS);
  });
  it("fails open to steer", async () => {
    const v = await governSteer(async () => { throw new Error("Judge HTTP 502"); }, "x", "y");
    expect(v.outcome).toBe("steer");
    expect(v.error).toContain("502");
  });
});

describe("silent accept (judge-unsure fallback)", () => {
  it("recognizes the bare token with stray punctuation or markdown", () => {
    for (const reply of ["ACCEPTED", "accepted.", "**ACCEPTED**", "  Accepted!\n"]) expect(silentAccept(reply)).toBe(true);
  });
  it("treats anything more than the token as a real reply", () => {
    for (const reply of ["Accepted — see drift's message above.", "Not accepted: the date is missing.", ""]) expect(silentAccept(reply)).toBe(false);
  });
});
