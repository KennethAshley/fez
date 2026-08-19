import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { Event } from "nostr-tools";
import { RelayConnection } from "@fez/protocol";
import { MiniRelay, waitFor } from "./mini-relay.js";

/**
 * The decentralization gate.
 *
 * "Decentralized" is a claim about what happens when a relay goes away,
 * so these are failure tests, not feature tests. Each one describes a
 * way the relay set can silently become a single relay while every
 * status light stays green — which is worse than having one relay,
 * because you'd have planned for that.
 */

const A = new MiniRelay(7801);
const B = new MiniRelay(7802);
const C = new MiniRelay(7803);
const sk = generateSecretKey();
let seq = 0;

const event = (content: string): Event =>
  finalizeEvent({ kind: 41999, created_at: Math.floor(Date.now() / 1000) + seq++, tags: [], content }, sk);

/** Put an event on ONE relay, behind the client's back. */
async function plant(relay: MiniRelay, content: string): Promise<Event> {
  const solo = new RelayConnection({ url: relay.url, watchdogMs: 50 });
  await solo.connect();
  const e = event(content);
  await solo.publish(e);
  solo.disconnect();
  return e;
}

beforeAll(async () => {
  await Promise.all([A.start(), B.start(), C.start()]);
});
afterAll(async () => {
  await Promise.all([A.stop(), B.stop(), C.stop()]);
});

describe("publishing to a relay set", () => {
  test("an event fans out to every relay", async () => {
    const conn = new RelayConnection({ urls: [A.url, B.url, C.url], watchdogMs: 50 });
    await conn.connect();
    const e = event("fan-out");
    await conn.publish(e);
    expect([A.has(e.id), B.has(e.id), C.has(e.id)]).toEqual([true, true, true]);
    conn.disconnect();
  });

  test("succeeds when one relay is down — the whole point of a set", async () => {
    const conn = new RelayConnection({ urls: [A.url, "ws://127.0.0.1:7899", B.url], watchdogMs: 50 });
    await conn.connect();
    const e = event("one down");
    await expect(conn.publish(e)).resolves.toBeUndefined();
    expect(A.has(e.id) && B.has(e.id)).toBe(true);
    conn.disconnect();
  });

  test("a policy rejection from ONE relay does not fail a published event", async () => {
    C.blockedKinds.add(41999);
    const errors: string[] = [];
    const conn = new RelayConnection({
      urls: [A.url, C.url],
      watchdogMs: 50,
      onError: (err) => errors.push(err.message),
    });
    await conn.connect();
    const e = event("partial policy reject");
    await expect(conn.publish(e)).resolves.toBeUndefined();
    expect(A.has(e.id)).toBe(true);
    expect(C.has(e.id)).toBe(false);
    // reported, not swallowed — the user's event IS published, but the
    // operator disagreement is real and someone should be able to see it
    expect(errors.join(" ")).toMatch(/1\/2 relays/);
    C.blockedKinds.delete(41999);
    conn.disconnect();
  });

  test("throws only when every relay refuses", async () => {
    for (const relay of [A, B]) relay.blockedKinds.add(41999);
    const conn = new RelayConnection({ urls: [A.url, B.url], watchdogMs: 50 });
    await conn.connect();
    await expect(conn.publish(event("nobody wants this"))).rejects.toThrow(/all 2 relay/);
    for (const relay of [A, B]) relay.blockedKinds.delete(41999);
    conn.disconnect();
  }, 10_000);

  test("throws when there are no relays at all rather than pretending", () => {
    expect(() => new RelayConnection({ urls: [] })).toThrow(/no relay URLs/);
  });
});

describe("reading from a relay set", () => {
  test("reads are the UNION: an event that reached only one relay still arrives", async () => {
    const onlyOnB = await plant(B, "exclusive to B");
    const onlyOnC = await plant(C, "exclusive to C");

    const conn = new RelayConnection({ urls: [A.url, B.url, C.url], watchdogMs: 50 });
    await conn.connect();
    const found = await conn.query([{ kinds: [41999], ids: [onlyOnB.id, onlyOnC.id] }]);
    expect(found.map((e) => e.id).sort()).toEqual([onlyOnB.id, onlyOnC.id].sort());
    conn.disconnect();
  });

  test("an event on all three relays is delivered ONCE", async () => {
    const conn = new RelayConnection({ urls: [A.url, B.url, C.url], watchdogMs: 50 });
    const seen: Event[] = [];
    await conn.connect();
    const unsub = conn.subscribe([{ kinds: [41999] }], (e) => seen.push(e));
    const e = event("delivered once");
    await conn.publish(e);
    await waitFor(() => seen.some((s) => s.id === e.id), 3000, "the event to arrive");
    // give the other two relays every chance to deliver their copies
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.filter((s) => s.id === e.id)).toHaveLength(1);
    unsub();
    conn.disconnect();
  });

  test("a live subscription keeps delivering when one relay dies under it", async () => {
    const D = new MiniRelay(7804);
    await D.start();
    const conn = new RelayConnection({ urls: [A.url, D.url], watchdogMs: 50 });
    const seen: Event[] = [];
    await conn.connect();
    const unsub = conn.subscribe([{ kinds: [41999] }], (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 150));

    await D.stop(); // one relay of two disappears mid-subscription
    const after = event("published after D died");
    await conn.publish(after);
    await waitFor(() => seen.some((s) => s.id === after.id), 4000, "delivery from the surviving relay");
    unsub();
    conn.disconnect();
  }, 15_000);
});

describe("keeping the set a set", () => {
  /**
   * The failure this whole file exists for. "Are we connected to
   * anything?" answers yes while two of three relays are dead, so a
   * naive client repairs nothing, runs on one relay indefinitely, and
   * reports full health the entire time.
   */
  test("a relay that comes back is reconnected and resubscribed, even though others stayed up", async () => {
    const E = new MiniRelay(7805);
    await E.start();
    const conn = new RelayConnection({ urls: [A.url, E.url], watchdogMs: 50 });
    const seen: Event[] = [];
    await conn.connect();
    const unsub = conn.subscribe([{ kinds: [41999] }], (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 150));

    expect(conn.health().filter((h) => h.connected)).toHaveLength(2);
    await E.stop();
    await waitFor(() => conn.health().filter((h) => h.connected).length === 1, 3000, "E to be seen as down");

    await E.start(); // the relay returns
    await waitFor(() => conn.health().filter((h) => h.connected).length === 2, 6000, "E to be repaired");

    // …and it is genuinely re-subscribed, not merely re-connected: an
    // event only E has must reach the live subscription.
    const exclusive = await plant(E, "only E has this, after recovery");
    await waitFor(() => seen.some((s) => s.id === exclusive.id), 5000, "E's exclusive event to arrive");
    unsub();
    conn.disconnect();
    await E.stop();
  }, 25_000);

  test("relays can be added at runtime and start serving the live subscription", async () => {
    const F = new MiniRelay(7806);
    await F.start();
    const conn = new RelayConnection({ urls: [A.url], watchdogMs: 50 });
    const seen: Event[] = [];
    await conn.connect();
    const unsub = conn.subscribe([{ kinds: [41999] }], (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 150));

    const beforeAdd = await plant(F, "on F before it was known");
    conn.addRelays([F.url]);
    await waitFor(() => seen.some((s) => s.id === beforeAdd.id), 5000, "F's backlog after add");
    expect(conn.relayUrls()).toHaveLength(2);

    unsub();
    conn.disconnect();
    await F.stop();
  }, 15_000);

  test("removing the last relay is refused — that isn't a configuration", async () => {
    const conn = new RelayConnection({ urls: [A.url, B.url], watchdogMs: 50 });
    await conn.connect();
    conn.removeRelays([B.url]);
    expect(conn.relayUrls()).toEqual([...conn.relayUrls()].slice(0, 1));
    expect(() => conn.removeRelays([A.url])).toThrow(/last relay/);
    conn.disconnect();
  });

  test("duplicate and differently-spelled relays collapse to one connection", async () => {
    const conn = new RelayConnection({ urls: [A.url, A.url + "/", A.url] });
    expect(conn.relayUrls()).toHaveLength(1);
    conn.disconnect();
  });
});
