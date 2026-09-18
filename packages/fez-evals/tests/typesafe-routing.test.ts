import { afterEach, describe, expect, it, vi } from "vitest";
import { runBench } from "../../fez-bench/src/runner.js";
import { runTypeSafeBench } from "../../fez-bench/src/typesafe.js";
import type { BenchCase } from "../../fez-bench/src/cases.js";
import { chooseTypeSafeRoute } from "../../fez-orchestrator/src/typesafe.js";

const roster = [
  { name: "researcher", about: "find papers", skills: ["web-search"] },
  { name: "reviewer", about: "review code" },
];
const cases: BenchCase[] = [
  { q: "hi", expect: ["none"], category: "smalltalk" },
  { q: "what can reviewer do?", expect: ["none"], category: "fleet-meta" },
  { q: "have reviewer check this", expect: ["reviewer"], category: "actor" },
  { q: "reviewer mentioned a paper, find it", expect: ["researcher"], category: "name-as-content" },
];
const response = () => ({
  model: "jev-1.13.0",
  answers: { route: { type: "choice", choice: "researcher", confidence: 0.8,
    probabilities: { researcher: 0.9, reviewer: 0.05, nobody: 0.05 } } },
  usage: { input_tokens: 120, output_tokens: 20 },
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("TypeSafe routing comparison", () => {
  it("shares deterministic prelayers with the baseline and sends only scrubbed task text", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "baseline" }] });
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (url.endsWith("/systemone")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
        expect(body.state).toEqual({ message: "a teammate mentioned a paper, find it" });
        expect(body.questions.route.criteria).toMatchObject({
          researcher: "find papers — skills: web-search", reviewer: "review code",
        });
        expect(body.questions.route.criteria.nobody).toBeTruthy();
        return Response.json(response());
      }
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "researcher" } }] } }] });
    });
    const candidate = await runTypeSafeBench("test-key", roster, cases);
    const baseline = await runBench("http://router.test/v1", roster, cases);
    const selections = (output: typeof baseline) => output.results.map(({ got, layer, pass }) => ({ got, layer, pass }));
    expect(selections(candidate)).toEqual([
      { got: "none", layer: "smalltalk", pass: true },
      { got: "none", layer: "fleet", pass: true },
      { got: "reviewer", layer: "actor", pass: true },
      { got: "researcher", layer: "router", pass: true },
    ]);
    expect(selections(baseline)).toEqual(selections(candidate));
    expect(requests).toHaveLength(2);
    expect(candidate.decisions).toHaveLength(1);
    expect(candidate.decisions[0]).toMatchObject({ confidence: 0.8, inputTokens: 120, outputTokens: 20 });
  });

  it("scores a valid no-match choice without treating it as an API failure", async () => {
    const body = response();
    body.answers.route.choice = "nobody";
    body.answers.route.probabilities = { researcher: 0.05, reviewer: 0.05, nobody: 0.9 };
    vi.stubGlobal("fetch", async () => Response.json(body));
    const output = await runTypeSafeBench("test-key", roster, [{ q: "draw a cat", expect: ["none"], category: "no-fit" }]);
    expect(output.results[0]).toMatchObject({ got: "none", pass: true, layer: "router" });
  });

  it.each([
    ["unknown target", { ...response(), answers: { route: { ...response().answers.route, choice: "stranger" } } }],
    ["missing probability", { ...response(), answers: { route: { ...response().answers.route, probabilities: { researcher: 1 } } } }],
    ["invalid confidence", { ...response(), answers: { route: { ...response().answers.route, confidence: 2 } } }],
    ["unnormalized distribution", { ...response(), answers: { route: { ...response().answers.route, probabilities: { researcher: 0.8, reviewer: 0.5, nobody: 0.1 } } } }],
    ["choice inconsistent with probabilities", { ...response(), answers: { route: { ...response().answers.route, choice: "reviewer" } } }],
    ["unaccounted usage", { ...response(), usage: { input_tokens: -1, output_tokens: 0 } }],
    ["model drift", { ...response(), model: "different-model" }],
  ])("rejects %s rather than counting it as a successful abstention", async (_name, body) => {
    vi.stubGlobal("fetch", async () => Response.json(body));
    await expect(runTypeSafeBench("test-key", roster, [cases[3]])).rejects.toThrow(/invalid TypeSafe response/i);
  });

  it("stops on service errors without leaking response bodies or retrying paid calls", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; return new Response("private provider debug text", { status: 429 }); });
    await expect(runTypeSafeBench("test-key", roster, [cases[3]])).rejects.toThrow(/^TypeSafe HTTP 429$/);
    expect(calls).toBe(1);
  });

  it("does not expose a non-JSON provider response in an error", async () => {
    vi.stubGlobal("fetch", async () => new Response("private provider debug text"));
    await expect(runTypeSafeBench("test-key", roster, [cases[3]])).rejects.toThrow(/^Invalid TypeSafe response: expected JSON$/);
  });

  it("does not give a failed baseline API credit for a no-fit case", async () => {
    vi.stubGlobal("fetch", async (url: string) => url.endsWith("/models")
      ? Response.json({ data: [{ id: "baseline" }] })
      : Response.json({ error: "unavailable" }, { status: 503 }));
    await expect(runBench("http://router.test/v1", roster, [{ q: "draw a cat", expect: ["none"], category: "no-fit" }]))
      .rejects.toThrow(/^Router HTTP 503$/);
  });

  it("bounds a stalled request", async () => {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    await expect(runTypeSafeBench("test-key", roster, [cases[3]], { timeoutMs: 10 })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it.each([0.9, 0])("validates special object-key candidates at probability %s", async selected => {
    vi.stubGlobal("fetch", async () => Response.json({ ...response(), answers: { route: {
      type: "choice", choice: "__proto__", confidence: 0.8,
      probabilities: Object.fromEntries([["__proto__", selected], ["nobody", 1 - selected]]),
    } } }));
    const decision = chooseTypeSafeRoute("test-key", "find papers",
      Object.fromEntries([["__proto__", "find papers"], ["nobody", "no match"]]));
    if (selected === 0) await expect(decision).rejects.toThrow(/probability distribution/);
    else expect((await decision).probabilities["__proto__"]).toBe(selected);
  });
});
