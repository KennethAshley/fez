import { describe, it, expect } from "vitest";
import { drainAbandonedTurn } from "../../../src/harness.js";

/**
 * A turn that exits without its "stop" — steered, timed out, past its
 * deadline — leaves the underlying prompt running. Those updates keep
 * arriving, and before this fence the NEXT turn's loop read them first
 * and accumulated them into its own text: a reply arrived with the
 * previous answer fused onto the front.
 */
function fakeSession(messages: unknown[], opts: { hang?: boolean } = {}) {
  let index = 0;
  return {
    consumed: () => index,
    nextUpdate: () =>
      index < messages.length
        ? Promise.resolve(messages[index++])
        : opts.hang
          ? new Promise<never>(() => {}) // never settles
          : Promise.reject(new Error("stream closed")),
  };
}

const chunk = (text: string) => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

describe("abandoned turn drain", () => {
  it("consumes the dead turn's tail through its stop, and no further", async () => {
    const session = fakeSession([
      chunk("ping — 10 seconds elapsed."),
      { kind: "stop", stopReason: "end_turn" },
      chunk("this belongs to the NEXT turn"),
    ]);
    await drainAbandonedTurn(session);
    // The tail and its stop are gone; the next turn's first update is not.
    expect(session.consumed()).toBe(2);
  });

  it("returns when the stream is closed rather than hanging", async () => {
    const session = fakeSession([chunk("half an answer")]);
    await expect(drainAbandonedTurn(session)).resolves.toBeUndefined();
  });

  it("gives up on its budget when the dead turn never stops", async () => {
    // The reason a turn timed out may be that the harness is wedged, so
    // the drain must not inherit that wedge.
    const session = fakeSession([chunk("…")], { hang: true });
    const started = Date.now();
    await drainAbandonedTurn(session, 150);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
