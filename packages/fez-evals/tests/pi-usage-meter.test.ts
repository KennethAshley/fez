import { expect, it } from "vitest";
import { installPiUsageMeter, patchPiUsageMeter } from "../../fez-desktop/scripts/pi-usage-meter.mjs";

it("reports native costs including cache/compaction, drains final usage, and resets the next prompt baseline", async () => {
  const frames: Record<string, unknown>[] = [];
  let cost = 2;
  let tokens = 100;
  class Session {
    sessionId = "session";
    pendingTurn = null;
    lastEmit = Promise.resolve();
    proc = { getSessionStats: async () => ({ cost, tokens: { input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens } }) };
    conn = { sessionUpdate: async ({ update }) => { frames.push(update._meta.fezUsage); } };
    startTurn(turn) { this.pendingTurn = turn; }
    handlePiEvent(event) {
      if (event.type === "agent_settled") void this.lastEmit.then(() => { this.pendingTurn.resolve(); this.pendingTurn = null; });
    }
    async cancel() {}
  }
  class Agent { async initialize() { return { _meta: { other: true } }; } }
  installPiUsageMeter(Session, Agent);
  expect(await new Agent().initialize()).toEqual({ _meta: { other: true, fezUsage: 1 } });
  const s = new Session();
  for (let i = 0; i < 2; i++) {
    let finish;
    const done = new Promise(r => { finish = r; });
    s.startTurn({ resolve: finish, reject: e => { throw e; } });
    await new Promise(r => setTimeout(r, 0));
    cost += 0.125; tokens += 10;
    s.handlePiEvent({ type: "message_end" });
    await s.lastEmit;
    cost += 0.0625; tokens += 10; // native stats include compaction/tool usage
    s.handlePiEvent({ type: "compaction_end" });
    s.handlePiEvent({ type: "agent_settled" });
    await done;
    expect(frames.at(-1)).toEqual({ costUsd: 0.1875, inputTokens: 60, outputTokens: 20, complete: true });
  }
  expect(frames).toHaveLength(6);
  expect(() => patchPiUsageMeter("upstream changed")).toThrow(/Unexpected/);
});
