import { expect, it } from "vitest";
import { agent } from "@agentclientprotocol/sdk";
import { createHarnessClient, drainAbandonedTurn, drivePrompt, type HarnessUpdate } from "../../../src/agent/harness.js";

it("reports Claude ACP's USD session costs as turn deltas and reads final token usage", async () => {
  let turn = 0;
  const costs = [[0.25, 0.5], [0.75], [], [1], [1.25]];
  const peer = agent().onRequest("session/new", () => ({ sessionId: "session" }))
    .onRequest("session/prompt", async ({ client }) => {
      for (const amount of costs[turn++]) {
        await client.notify("session/update", { sessionId: "session", update: {
          sessionUpdate: "usage_update", used: 100, size: 200000, cost: { amount, currency: "USD" },
        } });
      }
      return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3, cachedWriteTokens: 2, totalTokens: 20 } };
    });
  await createHarnessClient().app.connectWith(peer, async ctx => {
    const session = await ctx.buildSession("/tmp").start();
    const turns: HarnessUpdate[][] = [];
    for (let n = 0; n < costs.length; n++) {
      const updates: HarnessUpdate[] = [];
      await drivePrompt(session, "fixture", "usage", undefined, update => updates.push(update));
      turns.push(updates);
      expect(updates.at(-1)).toMatchObject({ type: "usage", inputTokens: 15, outputTokens: 5 });
    }
    expect(turns.map(updates => updates.flatMap(update => update.costUsd === undefined ? [] : [update.costUsd])))
      .toEqual([[0.25, 0.5], [0.25], [], [], [0.25]]);
  });
});

it.each([{ amount: 1, currency: "EUR" }, { amount: -1, currency: "USD" }])("leaves unsupported or invalid cost unknown ($currency $amount)", async cost => {
  const peer = agent().onRequest("session/new", () => ({ sessionId: "session" }))
    .onRequest("session/prompt", async ({ client }) => {
      await client.notify("session/update", { sessionId: "session", update: { sessionUpdate: "usage_update", used: 100, size: 200000, cost } });
      return { stopReason: "end_turn" };
    });
  await createHarnessClient().app.connectWith(peer, async ctx => {
    const session = await ctx.buildSession("/tmp").start();
    const updates: HarnessUpdate[] = [];
    await drivePrompt(session, "fixture", "usage", undefined, update => updates.push(update));
    expect(updates).toEqual([]);
  });
});

it("keeps late interrupted usage out of the following turn, including unobserved turns", async () => {
  let started!: () => void, release!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let turn = 0;
  const peer = agent().onRequest("session/new", () => ({ sessionId: "session" }))
    .onRequest("session/prompt", async ({ client }) => {
      const current = ++turn;
      if (current === 1) { started(); await held; }
      await client.notify("session/update", { sessionId: "session", update: {
        sessionUpdate: "usage_update", used: 100, size: 200000, cost: { amount: current * 0.25, currency: "USD" },
      } });
      return { stopReason: "end_turn" };
    });
  await createHarnessClient().app.connectWith(peer, async ctx => {
    const session = await ctx.buildSession("/tmp").start();
    const abort = new AbortController();
    const interrupted = drivePrompt(session, "fixture", "usage", undefined, undefined, abort.signal);
    const rejection = expect(interrupted).rejects.toMatchObject({ name: "AbortError" });
    await running;
    abort.abort();
    await rejection;
    release();
    await drainAbandonedTurn(session);
    await drivePrompt(session, "fixture", "without observer");
    const updates: HarnessUpdate[] = [];
    await drivePrompt(session, "fixture", "usage", undefined, update => updates.push(update));
    expect(updates).toEqual([{ type: "usage", costUsd: 0.25 }]);
  });
});

it("rejects a decreasing cumulative total rather than claim a zero-cost turn", async () => {
  let turn = 0;
  const peer = agent().onRequest("session/new", () => ({ sessionId: "session" }))
    .onRequest("session/prompt", async ({ client }) => {
      for (const amount of ++turn === 1 ? [0.5] : [0.75, 0.1]) {
        await client.notify("session/update", { sessionId: "session", update: {
          sessionUpdate: "usage_update", used: 100, size: 200000, cost: { amount, currency: "USD" },
        } });
      }
      return { stopReason: "end_turn" };
    });
  await createHarnessClient().app.connectWith(peer, async ctx => {
    const session = await ctx.buildSession("/tmp").start();
    await drivePrompt(session, "fixture", "usage");
    await expect(drivePrompt(session, "fixture", "usage")).rejects.toThrow("cumulative usage cost decreased");
  });
});

it.each([{ costUsd: -1 }, { total_cost_usd: Number.NaN }])("rejects malformed legacy cost after an observed charge ($costUsd $total_cost_usd)", async malformed => {
  const messages = [
    { update: { sessionUpdate: "plan", usage: { costUsd: 0.25 } } },
    { update: { sessionUpdate: "plan", usage: malformed } },
    { kind: "stop", stopReason: "end_turn" },
  ];
  const session = { prompt: async () => ({}), nextUpdate: async () => messages.shift() };
  const updates: HarnessUpdate[] = [];
  await expect(drivePrompt(session, "fixture", "usage", undefined, update => updates.push(update)))
    .rejects.toThrow("invalid usage cost");
  expect(updates).toContainEqual({ type: "usage", inputTokens: undefined, outputTokens: undefined, costUsd: 0.25 });
});
