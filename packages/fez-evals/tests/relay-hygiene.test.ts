import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as WsSocket } from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { startRelay, type RelayHandle } from "../../fez-relay/dist/relay.js";
import { createdAtFencePolicy } from "../../fez-relay/dist/policies.js";

/**
 * Ingest-hygiene gate for fez-relay (GAPS.md §2.2): duplicate dedup,
 * content size cap, NIP-01 newest-first limit, filters/subscription caps,
 * connection cap, and the created_at drift fence (with its NIP-17
 * gift-wrap exemption — fuzzed timestamps must pass the past fence).
 *
 * The slow-consumer disconnect isn't wire-tested here: bufferedAmount
 * can't be forced deterministically in-process. Its logic is a two-line
 * fence exercised in production by any stalled client.
 */

const PORT = 7793;
const sk = generateSecretKey();
const now = () => Math.floor(Date.now() / 1000);

const sign = (kind: number, content: string, created_at = now(), tags: string[][] = []) =>
  finalizeEvent({ kind, created_at, tags, content }, sk);

let relay: RelayHandle;

/** Minimal client: send frames, collect parsed messages. */
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
  relay = startRelay({
    port: PORT,
    limits: { maxContentBytes: 1024, maxSubsPerConn: 2, maxFiltersPerReq: 3, limitClamp: 5, maxConns: 3 },
    log: () => {},
  });
});

afterAll(() => relay.close());

describe("ingest dedup", () => {
  test("replayed EVENT gets OK=true 'duplicate', stored and fanned out once", async () => {
    const probe = new Probe();
    await probe.open();
    probe.send(["REQ", "watch", { kinds: [1310] }]);
    await probe.waitFor((m) => m[0] === "EOSE");

    const event = sign(1310, "once only");
    const before = relay.eventCount;
    probe.send(["EVENT", event]);
    const ok1 = await probe.waitFor((m) => m[0] === "OK" && m[1] === event.id);
    expect(ok1[2]).toBe(true);

    probe.send(["EVENT", event]); // client publish-retry replay
    await probe.waitFor((m) => m[0] === "OK" && m[1] === event.id && String(m[3]).startsWith("duplicate"));

    expect(relay.eventCount).toBe(before + 1);
    const deliveries = probe.messages.filter((m) => m[0] === "EVENT" && (m[2] as { id: string }).id === event.id);
    expect(deliveries).toHaveLength(1);
    probe.close();
  });
});

describe("size caps", () => {
  test("oversized content is rejected with OK=false", async () => {
    const probe = new Probe();
    await probe.open();
    const event = sign(1310, "x".repeat(2048)); // cap is 1024 in this run
    probe.send(["EVENT", event]);
    const ok = await probe.waitFor((m) => m[0] === "OK" && m[1] === event.id);
    expect(ok[2]).toBe(false);
    expect(String(ok[3])).toMatch(/too large/);
    probe.close();
  });
});

describe("NIP-01 REQ limit", () => {
  test("limit selects newest by created_at, not insertion order, and is clamped", async () => {
    const probe = new Probe();
    await probe.open();
    // Insert out of chronological order: newest is inserted FIRST.
    const base = now();
    const newest = sign(1311, "newest", base);
    const oldest = sign(1311, "oldest", base - 200);
    const middle = sign(1311, "middle", base - 100);
    for (const e of [newest, oldest, middle]) {
      probe.send(["EVENT", e]);
      await probe.waitFor((m) => m[0] === "OK" && m[1] === e.id);
    }

    probe.send(["REQ", "page", { kinds: [1311], limit: 2 }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "page");
    const got = probe.messages
      .filter((m) => m[0] === "EVENT" && m[1] === "page")
      .map((m) => (m[2] as { content: string }).content);
    expect(got).toEqual(["newest", "middle"]); // newest-first, oldest excluded

    // limitClamp is 5 in this run: limit 500 must not blow past it.
    probe.send(["REQ", "clamped", { kinds: [1311], limit: 500 }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "clamped");
    const clamped = probe.messages.filter((m) => m[0] === "EVENT" && m[1] === "clamped");
    expect(clamped.length).toBeLessThanOrEqual(5);
    probe.close();
  });
});


describe("NIP-50 search", () => {
  test("case-insensitive AND over tokens; non-matches excluded", async () => {
    const probe = new Probe();
    await probe.open();
    const docs = [
      sign(1320, "the Quick brown Fox jumps"),
      sign(1320, "lazy dog sleeps all day"),
      sign(1320, "quick fox trot lessons"),
    ];
    for (const e of docs) {
      probe.send(["EVENT", e]);
      await probe.waitFor((m) => m[0] === "OK" && m[1] === e.id);
    }
    probe.send(["REQ", "s1", { kinds: [1320], search: "QUICK fox" }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "s1");
    const got = probe.messages.filter((m) => m[0] === "EVENT" && m[1] === "s1").map((m) => (m[2] as { content: string }).content);
    expect(got).toHaveLength(2);
    expect(got.every((c) => /quick/i.test(c) && /fox/i.test(c))).toBe(true);

    probe.send(["REQ", "s2", { kinds: [1320], search: "zebra" }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "s2");
    expect(probe.messages.filter((m) => m[0] === "EVENT" && m[1] === "s2")).toHaveLength(0);
    probe.close();
  });
});

describe("NIP-09 deletion masking", () => {
  const other = generateSecretKey();
  const signAs = (key: Uint8Array, kind: number, content: string, tags: string[][] = []) =>
    finalizeEvent({ kind, created_at: now(), tags, content }, key);

  async function publish(probe: Probe, event: ReturnType<typeof sign>): Promise<void> {
    probe.send(["EVENT", event]);
    await probe.waitFor((m) => m[0] === "OK" && m[1] === event.id);
  }

  async function reqIds(probe: Probe, subId: string, filter: Record<string, unknown>): Promise<string[]> {
    probe.send(["REQ", subId, filter]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === subId);
    return probe.messages.filter((m) => m[0] === "EVENT" && m[1] === subId).map((m) => (m[2] as { id: string }).id);
  }

  test("author's kind 5 masks their message from REQ; the kind 5 itself still serves", async () => {
    const probe = new Probe();
    await probe.open();
    const msg = signAs(sk, 47103, "regrettable", [["h", "chan-x"]]);
    await publish(probe, msg);
    const del = signAs(sk, 5, "", [["e", msg.id], ["h", "chan-x"]]);
    await publish(probe, del);

    const served = await reqIds(probe, "after-del", { kinds: [47103], "#h": ["chan-x"] });
    expect(served).not.toContain(msg.id);
    const deletions = await reqIds(probe, "del-events", { kinds: [5], "#h": ["chan-x"] });
    expect(deletions).toContain(del.id); // clients need it for their tombstones
    probe.close();
  });

  test("someone else's kind 5 does not mask (author-match only at the relay)", async () => {
    const probe = new Probe();
    await probe.open();
    const msg = signAs(sk, 47103, "stays put", [["h", "chan-y"]]);
    await publish(probe, msg);
    const foreignDel = signAs(other, 5, "", [["e", msg.id], ["h", "chan-y"]]);
    await publish(probe, foreignDel);
    const served = await reqIds(probe, "foreign", { kinds: [47103], "#h": ["chan-y"] });
    expect(served).toContain(msg.id); // creator-moderation is a CLIENT rule; relay stays author-only
    probe.close();
  });

  test("trust-chain kinds (47102 roster) are never masked, even by their author", async () => {
    const probe = new Probe();
    await probe.open();
    const roster = signAs(sk, 47102, "", [["d", "chan-z"], ["c", "comm-z"], ["p", "someone"]]);
    await publish(probe, roster);
    const del = signAs(sk, 5, "", [["e", roster.id]]);
    await publish(probe, del);
    const served = await reqIds(probe, "roster", { kinds: [47102], "#d": ["chan-z"] });
    expect(served).toContain(roster.id); // masking a roster would resurrect an older roster
    probe.close();
  });
});

describe("replaceable-event compaction (NIP-16/33)", () => {
  test("only the latest 30078 per (author, d) is served; a late old version is not resurrected", async () => {
    const probe = new Probe();
    await probe.open();
    const base = now();
    const v1 = sign(30078, "v1", base - 100, [["d", "chan-r"]]);
    const v2 = sign(30078, "v2", base - 50, [["d", "chan-r"]]);
    const v3 = sign(30078, "v3", base, [["d", "chan-r"]]);
    for (const e of [v1, v3]) {
      probe.send(["EVENT", e]);
      await probe.waitFor((m) => m[0] === "OK" && m[1] === e.id);
    }
    // v2 arrives AFTER v3 but is older — accepted (OK) yet never served.
    probe.send(["EVENT", v2]);
    await probe.waitFor((m) => m[0] === "OK" && m[1] === v2.id);

    probe.send(["REQ", "rs", { kinds: [30078], "#d": ["chan-r"] }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "rs");
    const served = probe.messages
      .filter((m) => m[0] === "EVENT" && m[1] === "rs")
      .map((m) => (m[2] as { content: string }).content);
    expect(served).toEqual(["v3"]);
    probe.close();
  });

  test("different d values are independent", async () => {
    const probe = new Probe();
    await probe.open();
    const a = sign(30078, "a", now(), [["d", "chan-a"]]);
    const b = sign(30078, "b", now(), [["d", "chan-b"]]);
    for (const e of [a, b]) {
      probe.send(["EVENT", e]);
      await probe.waitFor((m) => m[0] === "OK" && m[1] === e.id);
    }
    probe.send(["REQ", "ind", { kinds: [30078], authors: [a.pubkey] }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "ind");
    const served = probe.messages.filter((m) => m[0] === "EVENT" && m[1] === "ind");
    expect(served.length).toBeGreaterThanOrEqual(2);
    probe.close();
  });
});

describe("created_at drift fence policy", () => {
  const fence = createdAtFencePolicy();
  const ctx = { query: () => [] };

  test("future-dated event rejected", () => {
    const verdict = fence.onEvent(sign(1312, "future", now() + 3600), ctx) as { accept: boolean; reason?: string };
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/future/);
  });

  test("backdated event rejected", () => {
    const verdict = fence.onEvent(sign(1312, "stale", now() - 3600), ctx) as { accept: boolean };
    expect(verdict.accept).toBe(false);
  });

  test("in-window event accepted", () => {
    const verdict = fence.onEvent(sign(1312, "fresh", now() - 60), ctx) as { accept: boolean };
    expect(verdict.accept).toBe(true);
  });

  test("gift wrap (1059) passes the past fence — NIP-17 fuzz is legitimate", () => {
    const wrap = sign(1059, "ciphertext", now() - 36 * 3600); // fuzzed 1.5 days back
    const verdict = fence.onEvent(wrap, ctx) as { accept: boolean };
    expect(verdict.accept).toBe(true);
  });

  test("gift wrap still fenced on the future side", () => {
    const wrap = sign(1059, "ciphertext", now() + 3600);
    const verdict = fence.onEvent(wrap, ctx) as { accept: boolean };
    expect(verdict.accept).toBe(false);
  });
});

// Runs LAST: it saturates the connection cap, and just-closed sockets
// still count against maxConns for a beat — later connects would race it.
describe("per-connection ceilings", () => {
  test("filters-per-REQ cap → CLOSED", async () => {
    const probe = new Probe();
    await probe.open();
    probe.send(["REQ", "wide", { kinds: [1] }, { kinds: [2] }, { kinds: [3] }, { kinds: [4] }]);
    const closed = await probe.waitFor((m) => m[0] === "CLOSED" && m[1] === "wide");
    expect(String(closed[2])).toMatch(/too many filters/);
    probe.close();
  });

  test("subscriptions-per-connection cap → CLOSED", async () => {
    const probe = new Probe();
    await probe.open();
    probe.send(["REQ", "a", { kinds: [1] }]);
    probe.send(["REQ", "b", { kinds: [1] }]);
    probe.send(["REQ", "c", { kinds: [1] }]);
    const closed = await probe.waitFor((m) => m[0] === "CLOSED" && m[1] === "c");
    expect(String(closed[2])).toMatch(/too many subscriptions/);
    // resubscribing an EXISTING id is not a new subscription — must pass
    probe.send(["REQ", "a", { kinds: [2] }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "a");
    probe.close();
  });

  test("connection cap → excess connection is closed", async () => {
    const probes: Probe[] = [];
    for (let i = 0; i < 3; i++) {
      const p = new Probe();
      await p.open();
      probes.push(p);
    }
    const extra = new Probe();
    await extra.open(); // accepted at TCP level, then closed by the relay
    const closed = await new Promise<boolean>((res) => {
      extra.ws.on("close", () => res(true));
      setTimeout(() => res(false), 3000);
    });
    expect(closed).toBe(true);
    probes.forEach((p) => p.close());
  });
});
