import { afterEach, describe, expect, test, vi } from "vitest";
import { askJudge, isTypeSafeDirect, TYPESAFE_DIRECT_URL, TYPESAFE_URL, type JudgeQuestion } from "../../fez-orchestrator/src/typesafe.js";
import { routerCall } from "../../fez-acp/src/guide-router.js";
import { routerBody, agentTool, noneTool } from "../../fez-orchestrator/src/route-logic.js";

/**
 * Bring your own key: with TypeSafe's API as the judge URL, the same call
 * sites talk to TypeSafe directly with the user's key — no fez gateway.
 * This is what a stranger's install uses after pasting a key in Settings.
 */
afterEach(() => vi.unstubAllGlobals());

describe("isTypeSafeDirect", () => {
  test("recognizes TypeSafe's API and nothing else", () => {
    expect(isTypeSafeDirect(TYPESAFE_DIRECT_URL)).toBe(true);
    expect(isTypeSafeDirect("https://api.typesafe.ai")).toBe(true);
    expect(isTypeSafeDirect("https://137-184-135-188.sslip.io/v1")).toBe(false);
    expect(isTypeSafeDirect(undefined)).toBe(false);
  });
});

describe("askJudge in direct mode", () => {
  test("posts the systemone request to TypeSafe with the user's key", async () => {
    let seen: { url: string; auth: string | null; body: Record<string, unknown> } | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen = { url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      return Response.json({ model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.91 } }, usage: { input_tokens: 10, output_tokens: 2 } });
    });
    const questions: Record<string, JudgeQuestion> = { ok: { type: "noul", instructions: "is it fine?" } };
    const result = await askJudge(TYPESAFE_DIRECT_URL, "ts-user-key", { message: "hi" }, questions);
    expect(seen).toMatchObject({ url: TYPESAFE_URL, auth: "Bearer ts-user-key", body: { model: "jev-1.13.0", state: { message: "hi" }, questions } });
    expect(result.answers.ok).toEqual({ type: "noul", noul: 0.91 });
  });
});

describe("routerCall in direct mode", () => {
  test("turns the routing tools into a Choice and returns the pick with its confidence", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ model: "jev-1.13.0", answers: { route: { type: "choice", choice: "drift", confidence: 0.9, probabilities: { drift: 0.93, quill: 0.05, nobody: 0.02 } } }, usage: { input_tokens: 10, output_tokens: 2 } });
    });
    const call = routerCall(TYPESAFE_DIRECT_URL, "ts-user-key");
    const tools = [agentTool({ name: "drift", about: "search the web" } as never), agentTool({ name: "quill", about: "write and edit" } as never), noneTool()];
    const answer = await call(routerBody("tools", "fez-router", "what is the latest Bun?", tools));
    expect(answer).toEqual({ choice: "drift", confidence: 0.9 });
    const questions = (body as { questions: { route: { criteria: Record<string, string> } } }).questions;
    expect(Object.keys(questions.route.criteria)).toEqual(["drift", "quill", "nobody"]);
    expect((body as { state: { message: string } }).state.message).toBe("what is the latest Bun?");
  });
});
