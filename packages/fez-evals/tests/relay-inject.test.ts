import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as WsSocket } from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { startRelay, type RelayHandle, type StoredEvent } from "../../fez-relay/dist/relay.js";

/**
 * Task 2 (relay-scheduler): the ingest pipeline extracted into `ingest()`
 * must stay the SAME pipeline whether an event arrives over the wire or
 * is fed in-process via `RelayHandle.inject()` — same dedupe, same
 * signature check, same policies, same store, same fan-out. `onEvent`
 * observers are the seam a built-in module (a scheduler) uses to react
 * to the relay's own traffic without opening a websocket to itself.
 */

const PORT = 7798;
const sk = generateSecretKey();
const ev = (content: string, createdAt: number) =>
  finalizeEvent({ kind: 47103, created_at: createdAt, tags: [["h", "chan1"]], content }, sk);

let relay: RelayHandle;

/** Minimal client: send frames, collect parsed messages (relay-hygiene.test.ts's Probe). */
class Probe {
  ws!: WsSocket;
  messages: unknown[][] = [];
  open(): Promise<void> {
    this.ws = new WsSocket(`ws://127.0.0.1:${PORT}`);
    this.ws.on("message", (raw) => this.messages.push(JSON.parse(raw.toString())));
    return new Promise((res, rej) => {
      this.ws.on("open", () => res());
      this.ws.on("error", rej);
    });
  }
  send(msg: unknown[]): void {
    this.ws.send(JSON.stringify(msg));
  }
  async waitFor(pred: (m: unknown[]) => boolean, timeoutMs = 3000): Promise<unknown[]> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out; got: ${JSON.stringify(this.messages.slice(-5))}`);
  }
  close(): void {
    this.ws.close();
  }
}

beforeAll(() => {
  relay = startRelay({ port: PORT, log: () => {} });
});

afterAll(() => relay.close());

describe("relay inject + observers", () => {
  test("inject runs the full pipeline: stores, fans out, notifies observers", async () => {
    const probe = new Probe();
    await probe.open();
    probe.send(["REQ", "watch", { kinds: [47103] }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "watch");

    const seenByObserver: StoredEvent[] = [];
    relay.onEvent((e) => seenByObserver.push(e));

    const e = ev("released", Math.floor(Date.now() / 1000));
    const verdict = await relay.inject(e);
    expect(verdict.accepted).toBe(true);

    // observer saw it
    expect(seenByObserver.map((x) => x.id)).toContain(e.id);
    // ws subscriber received ["EVENT", subId, e] — inject fans out same as wire
    const delivered = await probe.waitFor((m) => m[0] === "EVENT" && m[1] === "watch" && (m[2] as StoredEvent).id === e.id);
    expect((delivered[2] as StoredEvent).content).toBe("released");
    // relay.query returns it
    expect(relay.query({ kinds: [47103], ids: [e.id] }).map((x) => x.id)).toContain(e.id);

    probe.close();
  });

  test("inject of a duplicate id is rejected, not double-stored", async () => {
    const e = ev("once", Math.floor(Date.now() / 1000));
    const before = relay.eventCount;
    expect((await relay.inject(e)).accepted).toBe(true);
    expect((await relay.inject(e)).accepted).toBe(false);
    expect(relay.eventCount).toBe(before + 1);
    // query returns exactly one copy
    expect(relay.query({ ids: [e.id] })).toHaveLength(1);
  });

  test("inject verifies signatures — a tampered event is refused", async () => {
    const e = { ...ev("real", Math.floor(Date.now() / 1000)), content: "forged" };
    const verdict = await relay.inject(e);
    expect(verdict.accepted).toBe(false);
    expect(relay.query({ ids: [e.id] })).toHaveLength(0);
  });

  test("observers also see events arriving over the wire", async () => {
    const probe = new Probe();
    await probe.open();

    const seenByObserver: StoredEvent[] = [];
    relay.onEvent((observed) => seenByObserver.push(observed));

    const e = ev("wire arrival", Math.floor(Date.now() / 1000));
    probe.send(["EVENT", e]);
    await probe.waitFor((m) => m[0] === "OK" && m[1] === e.id && m[2] === true);

    expect(seenByObserver.map((x) => x.id)).toContain(e.id);
    probe.close();
  });
});
