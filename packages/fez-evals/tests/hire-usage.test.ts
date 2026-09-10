import { expect, it, vi } from "vitest";
import { agent } from "@agentclientprotocol/sdk";
import { createHarnessClient, drivePrompt, type HarnessUpdate } from "../../../src/agent/harness.js";
import { runMeteredHire } from "../../fez-acp/src/hire-usage.js";

it("forwards per-prompt engine costs and rejects malformed metering through the real ACP stream", async () => {
  const updates: HarnessUpdate[] = [];
  const peer = agent().onRequest("session/new", () => ({ sessionId: "session" }))
    .onRequest("session/prompt", async ({ client }) => {
      for (const costUsd of [0.02, 0.0481656]) await client.notify("session/update", {
        sessionId: "session", update: { sessionUpdate: "session_info_update", _meta: {
          fezUsage: { inputTokens: 100, outputTokens: 20, costUsd, complete: costUsd > 0.02 },
        } },
      });
      await client.notify("session/update", { sessionId: "session", update: {
        sessionUpdate: "session_info_update", _meta: { fezUsage: { costUsd: -1 } },
      } });
      return { stopReason: "end_turn" };
    });
  const bridge = createHarnessClient();
  await bridge.app.connectWith(peer, async ctx => {
    const session = await ctx.buildSession("/tmp").start();
    await drivePrompt(session, "test", "work", undefined, u => updates.push(u));
  });
  expect(updates.filter(u => u.type === "usage")).toEqual([
    { type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.02, metering: undefined },
    { type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.0481656, metering: "complete" },
    { type: "usage", metering: "unavailable" },
  ]);
});

it("stops at the allowance, reports partial spend, and never retries paid work", async () => {
  const frames: unknown[] = [];
  const invoke = vi.fn(async (_prompt, _cwd, _progress, _servers, update, signal) => {
    update({ type: "usage", metering: "ready" });
    update({ type: "usage", costUsd: 0.03, inputTokens: 10, outputTokens: 5 });
    expect(signal.aborted).toBe(true);
    throw new Error("connection reset");
  });
  await expect(runMeteredHire({ harness: { invoke, supportsCostMetering: true }, prompt: "fix", cwd: "/tmp", maxCostUsd: 0.02,
    onUsage: u => frames.push(u) })).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(frames).toEqual([{ costUsd: 0.03, inputTokens: 10, outputTokens: 5, complete: false }]);
});

it("refuses unmetered engines before their model call and requires a final total", async () => {
  let paid = false;
  const harness = { supportsCostMetering: true, invoke: async (_p, _c, _progress, _servers, update) => {
    update({ type: "usage", metering: "unavailable" }); paid = true; return "done";
  } };
  await expect(runMeteredHire({ harness, prompt: "fix", cwd: "/tmp", maxCostUsd: 1, onUsage() {} })).rejects.toThrow(/meter/i);
  expect(paid).toBe(false);
  harness.supportsCostMetering = false;
  await expect(runMeteredHire({ harness, prompt: "fix", cwd: "/tmp", maxCostUsd: 1, onUsage() {} })).rejects.toThrow(/meter/i);
  expect(paid).toBe(false);
  harness.supportsCostMetering = true;
  harness.invoke = async () => "unreported";
  await expect(runMeteredHire({ harness, prompt: "fix", cwd: "/tmp", maxCostUsd: 1, onUsage() {} })).rejects.toThrow(/meter/i);
});
