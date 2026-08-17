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
    probe.send(["REQ", "watch", { kinds: [30310] }]);
    await probe.waitFor((m) => m[0] === "EOSE");

    const event = sign(30310, "once only");
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
    const event = sign(30310, "x".repeat(2048)); // cap is 1024 in this run
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
    const newest = sign(30311, "newest", base);
    const oldest = sign(30311, "oldest", base - 200);
    const middle = sign(30311, "middle", base - 100);
    for (const e of [newest, oldest, middle]) {
      probe.send(["EVENT", e]);
      await probe.waitFor((m) => m[0] === "OK" && m[1] === e.id);
    }

    probe.send(["REQ", "page", { kinds: [30311], limit: 2 }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "page");
    const got = probe.messages
      .filter((m) => m[0] === "EVENT" && m[1] === "page")
      .map((m) => (m[2] as { content: string }).content);
    expect(got).toEqual(["newest", "middle"]); // newest-first, oldest excluded

    // limitClamp is 5 in this run: limit 500 must not blow past it.
    probe.send(["REQ", "clamped", { kinds: [30311], limit: 500 }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "clamped");
    const clamped = probe.messages.filter((m) => m[0] === "EVENT" && m[1] === "clamped");
    expect(clamped.length).toBeLessThanOrEqual(5);
    probe.close();
  });
});

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

describe("created_at drift fence policy", () => {
  const fence = createdAtFencePolicy();
  const ctx = { query: () => [] };

  test("future-dated event rejected", () => {
    const verdict = fence.onEvent(sign(30312, "future", now() + 3600), ctx) as { accept: boolean; reason?: string };
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/future/);
  });

  test("backdated event rejected", () => {
    const verdict = fence.onEvent(sign(30312, "stale", now() - 3600), ctx) as { accept: boolean };
    expect(verdict.accept).toBe(false);
  });

  test("in-window event accepted", () => {
    const verdict = fence.onEvent(sign(30312, "fresh", now() - 60), ctx) as { accept: boolean };
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
