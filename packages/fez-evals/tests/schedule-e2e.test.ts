import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as WsSocket } from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { startRelay, type RelayHandle, type StoredEvent } from "../../fez-relay/dist/relay.js";
import { activateScheduler } from "../../fez-relay/src/scheduler.js";
import { sealContent } from "../../../src/protocol/intents.js";

/**
 * Task 7 (relay-scheduler): the real end-to-end release — a sealed 40006
 * intent published over the wire to a REAL in-process relay (same harness
 * as relay-inject.test.ts), `activateScheduler` wired to that relay's own
 * query/onEvent/inject/log (not the fake API from relay-scheduler.test.ts),
 * a real ~1s wait past send_at, and a ws subscriber that must see the
 * embedded, author-signed event delivered through the relay's normal
 * ingest pipeline. A second scheduler activation (simulating a restart)
 * must not re-release it — the relay's own dedupe is what protects it.
 */

const PORT = 7899;
const sk = generateSecretKey();
const now = () => Math.floor(Date.now() / 1000);

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
  async waitFor(pred: (m: unknown[]) => boolean, timeoutMs = 4000): Promise<unknown[]> {
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

describe("schedule end-to-end (real relay, real timers)", () => {
  test("a sealed intent published over the wire is released by activateScheduler and delivered to a subscriber; a second activation does not double-deliver", async () => {
    const sendAt = now() + 1;
    const inner = finalizeEvent(
      { kind: 47103, created_at: sendAt, tags: [["h", "chan1"]], content: "hello from the future" },
      sk
    );
    const intent = finalizeEvent(
      {
        kind: 40006,
        created_at: now(),
        tags: [["h", "chan1"], ["send_at", String(sendAt)]],
        content: sealContent(inner),
      },
      sk
    );

    // Client publishes the sealed intent over the wire, like any other event.
    const publisher = new Probe();
    await publisher.open();
    publisher.send(["EVENT", intent]);
    await publisher.waitFor((m) => m[0] === "OK" && m[1] === intent.id && m[2] === true);
    publisher.close();

    // A subscriber watches for the embedded kind, exactly as it would for
    // any ordinary message — it has no idea a scheduler is involved.
    const watcher = new Probe();
    await watcher.open();
    watcher.send(["REQ", "watch", { kinds: [47103] }]);
    await watcher.waitFor((m) => m[0] === "EOSE" && m[1] === "watch");

    // Wire the scheduler to the REAL relay — its query/onEvent/inject,
    // wrapped with a `log` exactly as cli.ts does (RelayHandle itself has
    // no `log` method). Not a fake API. This picks up the intent already
    // stored above.
    const schedulerApi = {
      query: (f: Record<string, unknown>) => relay.query(f),
      onEvent: (cb: (e: StoredEvent) => void) => relay.onEvent(cb),
      inject: (e: StoredEvent) => relay.inject(e),
      log: () => {},
    };
    activateScheduler(schedulerApi);

    // Real ~1s wait past send_at (no fake timers) — the relay must inject
    // the embedded event on its own clock.
    const delivered = await watcher.waitFor(
      (m) => m[0] === "EVENT" && m[1] === "watch" && (m[2] as StoredEvent).id === inner.id
    );
    expect((delivered[2] as StoredEvent).content).toBe("hello from the future");
    expect((delivered[2] as StoredEvent).sig).toBe(inner.sig);

    // The relay stores exactly one copy of the released event.
    expect(relay.query({ kinds: [47103], ids: [inner.id] })).toHaveLength(1);

    // A second activation (simulating a relay restart) must not
    // re-release it: the intent is still in the store, but the embedded
    // event is already known, so re-injection is refused by dedupe.
    activateScheduler(schedulerApi);
    await new Promise((r) => setTimeout(r, 1200));
    expect(relay.query({ kinds: [47103], ids: [inner.id] })).toHaveLength(1);

    watcher.close();
  }, 8000);
});
