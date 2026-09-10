import { afterEach, expect, it, vi } from "vitest";
import { agent, methods } from "@agentclientprotocol/sdk";
import { createHarnessClient, drivePrompt, type InputHandler } from "../../../src/agent/harness.js";

afterEach(() => vi.useRealTimers());

it.each([{ idleMs: 20, afterMs: 15 }, { idleMs: 100, afterMs: 70 }])("negotiates forms and gives the resumed tool its full idle window ($idleMs ms)", async ({ idleMs, afterMs }) => {
  vi.useFakeTimers();
  const form = { mode: "form" as const, sessionId: "session", message: "Two questions", requestedSchema: { properties: {
    first: { type: "string" as const, enum: ["one", "two"] }, second: { type: "string" as const },
  } } };
  const answers = { action: "accept" as const, content: { first: "two", second: "my answer" } };
  const onInput = vi.fn<InputHandler>(async () => { await new Promise(r => setTimeout(r, 80)); return answers; });
  let capabilities: unknown;
  let response: unknown;
  const peer = agent({ name: "test-agent" })
    .onRequest("initialize", ({ params }) => { capabilities = params.clientCapabilities; return { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] }; })
    .onRequest("session/new", () => ({ sessionId: "session" }))
    .onRequest("session/prompt", async ({ client }) => {
      response = await client.request(methods.client.elicitation.create, form);
      await new Promise(r => setTimeout(r, afterMs));
      await client.notify("session/update", { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answered" } } });
      return { stopReason: "end_turn" };
    });
  const bridge = createHarnessClient(onInput);
  const result = bridge.app.connectWith(peer, async ctx => {
    await bridge.initialize(ctx);
    const session = await ctx.buildSession("/tmp").start();
    return drivePrompt(session, "test", "ask", undefined, undefined, undefined, { idleMs, maxMs: 500 }, undefined, bridge.input);
  });
  const check = expect(result).resolves.toBe("answered");
  await vi.advanceTimersByTimeAsync(200);
  await check;
  expect(capabilities).toMatchObject({ elicitation: { form: {} } });
  expect(onInput.mock.calls[0][0].fields).toHaveLength(2);
  expect(response).toEqual(answers);
});

it("cancels a question when its turn aborts even if the host never resolves", async () => {
  const abort = new AbortController();
  const bridge = createHarnessClient(async () => new Promise(() => {}));
  const peer = agent().onRequest("session/new", () => ({ sessionId: "session" }))
    .onRequest("session/prompt", async ({ client }) => {
      const response = client.request(methods.client.elicitation.create, { mode: "form", sessionId: "session", message: "Ask", requestedSchema: { properties: { answer: { type: "string" } } } });
      await new Promise(r => setTimeout(r, 10));
      abort.abort();
      expect(await response).toEqual({ action: "cancel" });
      return { stopReason: "end_turn" };
    });
  await bridge.app.connectWith(peer, async ctx => {
    const session = await ctx.buildSession("/tmp").start();
    await expect(drivePrompt(session, "test", "ask", undefined, undefined, abort.signal, undefined, undefined, bridge.input)).rejects.toMatchObject({ name: "AbortError" });
  });
  expect(bridge.input.pending).toBe(0);
});
