import { afterEach, describe, expect, test, vi } from "vitest";
import { askJudge, isDirectJudge, JEV_DIRECT_URL, ZILS_URL, type JudgeQuestion } from "../../fez-orchestrator/src/judge.js";
import { routerCall } from "../../fez-acp/src/guide-router.js";
import { routerBody, agentTool, noneTool } from "../../fez-orchestrator/src/route-logic.js";

/**
 * Zils is the room's controller: with the Zils decision API as the judge
 * URL, every judge and routing call goes straight to Zils with the user's
 * key and the shared Zils model. No fez gateway in between.
 */
afterEach(() => vi.unstubAllGlobals());

const usage = { input_tokens: 10, output_tokens: 0, billable_input_tokens: 10 };

describe("isDirectJudge", () => {
  test("recognizes the Zils decision API and Jev's API, and no gateway", () => {
    expect(isDirectJudge(ZILS_URL)).toBe(true);
    expect(isDirectJudge(ZILS_URL + "/")).toBe(true);
    expect(isDirectJudge(JEV_DIRECT_URL)).toBe(true);
    expect(isDirectJudge("https://training.zils.ai/relay/abc/v1")).toBe(false);
    expect(isDirectJudge("https://137-184-135-188.sslip.io/v1")).toBe(false);
    expect(isDirectJudge(undefined)).toBe(false);
  });
});

describe("askJudge with Zils as the judge", () => {
  test("posts the systemone request to Zils with the user's key and the shared model", async () => {
    let seen: { url: string; auth: string | null; body: Record<string, unknown> } | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen = { url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      // Zils echoes the immutable release behind the alias, not the alias.
      return Response.json({ model: "z3-mini-r7", answers: { ok: { type: "noul", noul: 0.91 } }, usage });
    });
    const questions: Record<string, JudgeQuestion> = { ok: { type: "noul", instructions: "is it fine?" } };
    const result = await askJudge(ZILS_URL + "/", "zils-user-key", { message: "hi" }, questions);
    expect(seen).toMatchObject({
      url: "https://training.zils.ai/decision/v1/systemone",
      auth: "Bearer zils-user-key",
      body: { model: "zils-shared", state: { message: "hi" }, questions },
    });
    expect(result.model).toBe("z3-mini-r7");
    expect(result.answers.ok).toEqual({ type: "noul", noul: 0.91 });
  });
});

describe("what Zils accepts", () => {
  // Measured live 26 Nov 2026: Zils answers text instructions and rejects a
  // structured one with 422 "Request exceeds the model's limits"; its
  // models list says max_questions 8. The room asks both shapes.
  test("structured instructions are sent to Zils as JSON text, and answers keep the caller's question", async () => {
    let body: { questions: Record<string, { instructions: unknown }> } | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ model: "z3-mini-r7", answers: { asks: { type: "noul", noul: 0.8 } }, usage });
    });
    const instructions = { agent: "drift", question: "Does the latest message ask `agent` to act?" };
    const result = await askJudge(ZILS_URL, "k", { thread: [] }, { asks: { type: "noul", instructions } });
    expect(body?.questions.asks.instructions).toBe(JSON.stringify(instructions));
    expect(result.answers.asks).toEqual({ type: "noul", noul: 0.8 });
  });

  test("more than eight questions go to Zils in requests of eight and come back as one result", async () => {
    const sizes: number[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const names = Object.keys(JSON.parse(String(init?.body)).questions);
      sizes.push(names.length);
      return Response.json({ model: "z3-mini-r7", usage, answers: Object.fromEntries(names.map((n) => [n, { type: "noul", noul: 0.5 }])) });
    });
    const questions = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`q${i}`, { type: "noul", instructions: `is ${i}?` } as JudgeQuestion]));
    const result = await askJudge(ZILS_URL, "k", "state", questions);
    expect(sizes.sort()).toEqual([3, 8, 8]);
    expect(Object.keys(result.answers)).toEqual(Object.keys(questions));
    expect(result.inputTokens).toBe(30);
  });
});

describe("routerCall with Zils as the router", () => {
  test("asks Zils one Choice over the routable agents and returns its pick", async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return Response.json({ model: "z3-mini-r7", usage, answers: { route: { type: "choice", choice: "drift", confidence: 0.9, probabilities: { drift: 0.93, quill: 0.05, nobody: 0.02 } } } });
    });
    const call = routerCall(ZILS_URL, "zils-user-key");
    const tools = [agentTool({ name: "drift", about: "search the web" } as never), agentTool({ name: "quill", about: "write and edit" } as never), noneTool()];
    const answer = await call(routerBody("tools", "fez-router", "what is the latest Bun?", tools));
    expect(answer).toEqual({ choice: "drift", confidence: 0.9 });
    expect(seen?.url).toBe("https://training.zils.ai/decision/v1/systemone");
    expect(seen?.body.model).toBe("zils-shared");
  });
});
