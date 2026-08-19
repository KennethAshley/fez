import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { BrowserWire } from "../../fez-desktop/src/wire.js";
import { MiniRelay, waitFor } from "./mini-relay.js";

/**
 * The desktop app has its OWN wire — a webview can't use nostr-tools'
 * node pool — which means the multi-relay rules are implemented twice.
 * Two implementations of the same guarantee is how a GUI ends up quietly
 * single-relay while the CLI is fine and every test passes.
 *
 * So this file asserts the same three properties as multi-relay.test.ts,
 * against the browser implementation, over real sockets.
 */

const A = new MiniRelay(7811);
const B = new MiniRelay(7812);
const key = Buffer.from(generateSecretKey()).toString("hex");
const otherSk = generateSecretKey();
let seq = 0;

beforeAll(async () => {
  await Promise.all([A.start(), B.start()]);
});
afterAll(async () => {
  await Promise.all([A.stop(), B.stop()]);
});

function wire(urls: string[]): BrowserWire {
  return new BrowserWire(urls, key);
}

const connected = (w: BrowserWire, n: number, label: string) =>
  waitFor(() => w.health().filter((h) => h.connected).length === n, 5000, label);

/** Put an event on ONE relay without going through the wire under test. */
async function plant(relay: MiniRelay, content: string) {
  const event = finalizeEvent(
    { kind: 41997, created_at: Math.floor(Date.now() / 1000) + seq++, tags: [], content },
    otherSk
  );
  const solo = wire([relay.url]);
  await connected(solo, 1, "planting connection");
  await (solo as unknown as { publishSigned(e: unknown): Promise<void> }).publishSigned(event);
  solo.close();
  return event;
}

describe("the desktop wire over a relay set", () => {
  test("publishes fan out to every relay", async () => {
    const w = wire([A.url, B.url]);
    await connected(w, 2, "both relays");
    const event = await w.publish({ kind: 41997, tags: [], content: "gui fan-out" });
    expect([A.has(event.id), B.has(event.id)]).toEqual([true, true]);
    w.close();
  }, 15_000);

  test("a publish succeeds while one relay is down", async () => {
    const w = wire([A.url, "ws://127.0.0.1:7899"]);
    await connected(w, 1, "the reachable relay");
    const event = await w.publish({ kind: 41997, tags: [], content: "gui one-down" });
    expect(A.has(event.id)).toBe(true);
    w.close();
  }, 15_000);

  test("a rejection from one relay does not fail an accepted publish", async () => {
    B.blockedKinds.add(41997);
    const w = wire([A.url, B.url]);
    await connected(w, 2, "both relays");
    const event = await w.publish({ kind: 41997, tags: [], content: "gui partial reject" });
    expect(A.has(event.id)).toBe(true);
    expect(B.has(event.id)).toBe(false);
    B.blockedKinds.delete(41997);
    w.close();
  }, 15_000);

  test("a publish every relay rejects does fail", async () => {
    for (const relay of [A, B]) relay.blockedKinds.add(41997);
    const w = wire([A.url, B.url]);
    await connected(w, 2, "both relays");
    await expect(w.publish({ kind: 41997, tags: [], content: "gui total reject" })).rejects.toThrow();
    for (const relay of [A, B]) relay.blockedKinds.delete(41997);
    w.close();
  }, 15_000);

  test("queries are the union, and wait for every relay rather than the first", async () => {
    const onA = await plant(A, "gui: only on A");
    const onB = await plant(B, "gui: only on B");
    const w = wire([A.url, B.url]);
    await connected(w, 2, "both relays");
    const found = await w.query([{ ids: [onA.id, onB.id] }]);
    expect(found.map((e) => e.id).sort()).toEqual([onA.id, onB.id].sort());
    w.close();
  }, 20_000);

  test("an event held by both relays is delivered to a subscription once", async () => {
    const w = wire([A.url, B.url]);
    await connected(w, 2, "both relays");
    const seen: { id: string }[] = [];
    const unsub = w.subscribe([{ kinds: [41997] }], (e) => seen.push(e));
    const event = await w.publish({ kind: 41997, tags: [], content: "gui delivered once" });
    await waitFor(() => seen.some((s) => s.id === event.id), 5000, "delivery");
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.filter((s) => s.id === event.id)).toHaveLength(1);
    unsub();
    w.close();
  }, 20_000);

  test("a query answers promptly when a relay is unreachable, instead of stalling", async () => {
    const w = wire([A.url, "ws://127.0.0.1:7899"]);
    await connected(w, 1, "the reachable relay");
    const started = Date.now();
    await w.query([{ kinds: [41997], limit: 1 }]);
    // The 8s backstop exists for a relay that never EOSEs; a relay that
    // isn't connected at all must not be waited on at all.
    expect(Date.now() - started).toBeLessThan(3000);
    w.close();
  }, 15_000);

  test("a relay that returns is reconnected and resubscribed, not left behind", async () => {
    const C = new MiniRelay(7813);
    await C.start();
    const w = wire([A.url, C.url]);
    await connected(w, 2, "both relays");
    const seen: { id: string }[] = [];
    const unsub = w.subscribe([{ kinds: [41997] }], (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 200));

    await C.stop();
    await connected(w, 1, "C seen as down");
    await C.start();
    await connected(w, 2, "C repaired");

    const exclusive = await plant(C, "gui: only C has this, after recovery");
    await waitFor(() => seen.some((s) => s.id === exclusive.id), 8000, "C's event after recovery");
    unsub();
    w.close();
    await C.stop();
  }, 40_000);

  test("refuses to be constructed with no relays", () => {
    expect(() => wire([])).toThrow(/no relay URLs/);
  });
});
