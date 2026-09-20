import { afterEach, describe, expect, it, vi } from "vitest";
import { askJudge, judge, validateJudgeQuestions } from "../../fez-orchestrator/src/typesafe.js";

const questions = {
  urgent: { type: "noul", instructions: "Does this convey urgency?" },
  severity: { type: "score", instructions: "How severe?", criteria: ["cosmetic", "degraded", "blocking"] },
  team: { type: "choice", instructions: "Which team?", criteria: { billing: "money", technical: "bugs" } },
} as const;

const answers = () => ({
  urgent: { type: "noul", noul: 0.9 },
  severity: { type: "score", score: 1.4, confidence: 0.4, legend: { 0: "cosmetic", 1: "degraded", 2: "blocking" },
    probabilities: { 0: 0.0, 1: 0.6, 2: 0.4 } },
  team: { type: "choice", choice: "technical", confidence: 0.8, probabilities: { billing: 0.1, technical: 0.9 } },
});
const response = (overrides: Record<string, unknown> = {}) => ({
  model: "jev-1.13.0", answers: { ...answers(), ...overrides }, usage: { input_tokens: 300, output_tokens: 30 },
});

afterEach(() => vi.unstubAllGlobals());

describe("judge", () => {
  it("sends state and questions to TypeSafe and returns every typed answer", async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
      request = JSON.parse(String(init?.body));
      return Response.json(response());
    });
    const result = await judge("test-key", { thread: ["a: hi", "b: hello"] }, questions);
    expect(request).toEqual({ model: "jev-1.13.0", state: { thread: ["a: hi", "b: hello"] }, questions });
    expect(result.answers.urgent).toEqual({ type: "noul", noul: 0.9 });
    expect(result.answers.severity).toMatchObject({ type: "score", score: 1.4, confidence: 0.4 });
    expect(result.answers.team).toMatchObject({ type: "choice", choice: "technical" });
    expect(result).toMatchObject({ model: "jev-1.13.0", inputTokens: 300, outputTokens: 30 });
  });

  it.each([
    ["a missing answer", { urgent: undefined }],
    ["a noul outside 0–1", { urgent: { type: "noul", noul: 1.2 } }],
    ["a type that doesn't match the question", { urgent: { type: "choice", choice: "x", confidence: 1, probabilities: { x: 1 } } }],
    ["score probabilities that don't cover the levels", { severity: { type: "score", score: 1, confidence: 1, probabilities: { 0: 1 } } }],
    ["a score outside the level range", { severity: { type: "score", score: 2.5, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 1 } } }],
    ["a choice not in the criteria", { team: { type: "choice", choice: "sales", confidence: 1, probabilities: { billing: 0, technical: 1 } } }],
    ["choice probabilities that don't sum to one", { team: { type: "choice", choice: "technical", confidence: 1, probabilities: { billing: 0.5, technical: 0.9 } } }],
  ])("rejects %s instead of returning a partial result", async (_label, overrides) => {
    vi.stubGlobal("fetch", async () => Response.json(response(overrides)));
    await expect(judge("test-key", "x", questions)).rejects.toThrow(/Invalid TypeSafe response/);
  });

  it("does not expose provider error bodies and never retries", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; return new Response("secret-echo", { status: 503 }); });
    await expect(judge("test-key", "x", questions)).rejects.toThrow("TypeSafe HTTP 503");
    expect(calls).toBe(1);
  });
});

describe("validateJudgeQuestions", () => {
  it("accepts the three primitives", () => {
    expect(() => validateJudgeQuestions(questions)).not.toThrow();
  });
  it.each([
    ["no questions", {}],
    ["an unknown type", { q: { type: "extract", instructions: "x" } }],
    ["missing instructions", { q: { type: "noul" } }],
    ["a choice with one option", { q: { type: "choice", instructions: "x", criteria: { only: "one" } } }],
    ["a score with one level", { q: { type: "score", instructions: "x", criteria: ["one"] } }],
    ["a score with eleven levels", { q: { type: "score", instructions: "x", criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } }],
    ["too many questions", Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, { type: "noul", instructions: "x" }]))],
  ])("rejects %s", (_label, bad) => {
    expect(() => validateJudgeQuestions(bad)).toThrow();
  });
});

describe("askJudge", () => {
  it("posts to the gateway judge route with the router key and validates the same way", async () => {
    let request: Record<string, unknown> | undefined, target = "";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      target = url;
      expect(init?.headers).toMatchObject({ Authorization: "Bearer router-key" });
      request = JSON.parse(String(init?.body));
      return Response.json(response());
    });
    const result = await askJudge("https://router.example/v1/", "router-key", "state text", questions);
    expect(target).toBe("https://router.example/v1/judge");
    expect(request).toEqual({ state: "state text", questions });
    expect(result.answers.urgent).toEqual({ type: "noul", noul: 0.9 });
  });

  it("surfaces gateway failures as errors without a body", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: { message: "judge unavailable" } }, { status: 503 }));
    await expect(askJudge("https://router.example/v1", "k", "x", questions)).rejects.toThrow("Judge HTTP 503");
  });
});
