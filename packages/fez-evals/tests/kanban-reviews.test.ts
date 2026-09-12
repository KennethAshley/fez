import { expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import { matchFilter, type Filter } from "nostr-tools";
import { dailySlot, parseReviews, type BoardReview } from "../../fez-kanban/src/reviews.js";
import { pollReviews } from "../../fez-kanban/src/headless.js";
import { completeWork } from "../../fez-client/src/work-completion.js";
import { readFileSync } from "node:fs";
import activate from "../../fez-kanban/src/headless.js";

const key = new Uint8Array(32).fill(21), agentKey = new Uint8Array(32).fill(22);
const owner = getPublicKey(key), worker = getPublicKey(agentKey);
const start = Date.parse("2026-09-12T12:00:00Z");
const review: BoardReview = { channelId: "work", slug: "fez-work", title: "Fez work", worker, time: "09:00", timeZone: "America/New_York", prompt: "Review KennethAshley/fez and prepare one tested fix.", enabled: true, enabledAt: start };
const sign = (t: Partial<EventTemplate>) => finalizeEvent({ kind: 47103, tags: [], content: "", created_at: start / 1000, ...t }, key);

function harness(shared?: Event[]) {
  const events: Event[] = shared ?? [
    sign({ kind: 47101, tags: [["d", "work"]], content: '{"name":"work"}' }),
    sign({ kind: 47102, tags: [["d", "roster"], ["p", worker, "bot"]] }),
    sign({ kind: 47006, tags: [["p", worker]] }),
  ];
  const values = new Map<string, unknown>();
  let settings = { reviews: [{ ...review }] }, now = start;
  const query = async (filters: Record<string, unknown>[]) => [sign({ kind: 30078, tags: [["d", "ext:fez-kanban"]], content: JSON.stringify(settings) }), ...events]
    .filter(e => filters.some(f => matchFilter(f as Filter, e))).sort((a, b) => b.created_at - a.created_at);
  const nostr = {
    pubkey: owner, signEvent: (t: Partial<EventTemplate>) => sign({ created_at: now / 1000, ...t }),
    publish: vi.fn(async (t: Partial<EventTemplate>) => { const e = sign(t); events.push(e); return e; }),
    query, queryWithStatus: async (f: Record<string, unknown>[]) => ({ events: await query(f), failures: [] as { url: string; reason: string }[] }),
    encrypt: (_pk: string, text: string) => text, decrypt: (_pk: string, text: string) => text,
  };
  const storage = { get: async <T,>(k: string) => structuredClone(values.get(k)) as T | undefined, set: vi.fn(async (k: string, v: unknown) => { values.set(k, structuredClone(v)); }) };
  const api = { storage, workspace: { owner, relayUrl: "wss://relay.example" } };
  const ctx = { ownerPubkey: owner, nostr, channels: { list: async () => [{ id: "work", name: "work" }], ensure: async () => undefined, say: async () => "" }, missedWindow: false };
  return { events, values, nostr, storage, settings: (...reviews: BoardReview[]) => { settings = { reviews }; }, tick: (date: string) => { now = Date.parse(date); return pollReviews(api, ctx, now); } };
}

it("keeps 9 AM Eastern across DST, starts at the next scheduled time, and skips missed days", () => {
  expect(dailySlot(review, start)).toBeUndefined();
  expect(dailySlot(review, Date.parse("2026-09-12T13:00:00Z"))).toBe("2026-09-12");
  expect(dailySlot(review, Date.parse("2026-12-01T13:59:00Z"))).toBeUndefined();
  expect(dailySlot(review, Date.parse("2026-12-01T14:00:00Z"))).toBe("2026-12-01");
  expect(dailySlot({ ...review, enabledAt: Date.parse("2026-09-12T14:00:00Z") }, Date.parse("2026-09-12T15:00:00Z"))).toBeUndefined();
  expect(dailySlot({ ...review, enabled: false }, Date.parse("2026-09-12T13:00:00Z"))).toBeUndefined();
  expect(parseReviews(undefined)).toEqual({ reviews: [] });
  for (const change of [{ time: "25:00" }, { timeZone: "Mars" }, { enabled: "yes" }, { worker: "fez" }, { prompt: "" }, { enabledAt: NaN }]) {
    expect(() => parseReviews({ reviews: [{ ...review, ...change }] })).toThrow();
  }
});

it("installs a background part and registers it on the existing minute scheduler", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../fez-kanban/package.json", import.meta.url), "utf8"));
  expect(pkg.fez.parts.background).toBe(true);
  expect(pkg.fez.parts.headless).toBe("dist/headless.js");
  const registerScheduledTask = vi.fn();
  activate({ registerScheduledTask } as Parameters<typeof activate>[0]);
  expect(registerScheduledTask).toHaveBeenCalledWith("kanban-daily-review", 60_000, expect.any(Function));
});

it("dispatches one addressed thread per day and waits for a signed completion before more work", async () => {
  const h = harness();
  await h.tick("2026-09-12T12:59:00Z"); expect(h.nostr.publish).not.toHaveBeenCalled();
  await h.tick("2026-09-12T13:00:00Z");
  const request = h.events.at(-1)!;
  expect(request.tags).toContainEqual(["task", worker]);
  expect(request.tags).toContainEqual(["p", worker]);
  expect(request.content).toContain("fez-work");
  expect(request.content).toContain("Review");
  await h.tick("2026-09-12T14:00:00Z");
  await h.tick("2026-09-13T13:00:00Z"); expect(h.nostr.publish).toHaveBeenCalledTimes(1);
  const result = completeWork(request, worker, { status: "success", summary: "Fix in Review", capability: "coding", artifacts: [] });
  h.events.push(finalizeEvent({ ...result, created_at: start / 1000 + 90_000 }, agentKey));
  await h.tick("2026-09-13T14:00:00Z"); expect(h.nostr.publish).toHaveBeenCalledTimes(2);
  h.settings({ ...review, enabled: false });
  await h.tick("2026-09-14T13:00:00Z"); expect(h.nostr.publish).toHaveBeenCalledTimes(2);
});

it("recovers a lost ACK without another task and rechecks pause at the publishing boundary", async () => {
  const h = harness();
  const publish = h.nostr.publish.getMockImplementation()!;
  h.nostr.publish.mockImplementationOnce(async t => { await publish(t); throw Error("lost ACK"); });
  await expect(h.tick("2026-09-12T13:00:00Z")).rejects.toThrow("lost ACK");
  await h.tick("2026-09-12T13:01:00Z"); expect(h.nostr.publish).toHaveBeenCalledTimes(1);
  const paused = harness(), set = paused.storage.set.getMockImplementation()!;
  paused.storage.set.mockImplementation(async (k, v) => { await set(k, v); paused.settings({ ...review, enabled: false }); });
  await expect(paused.tick("2026-09-12T13:00:00Z")).rejects.toThrow(/changed|paused/i);
  expect(paused.nostr.publish).not.toHaveBeenCalled();
});

it("refuses incomplete relay reads or revoked agent membership", async () => {
  const h = harness();
  h.nostr.queryWithStatus = async () => ({ events: [], failures: [{ url: "wss://relay.example", reason: "offline" }] });
  await expect(h.tick("2026-09-12T13:00:00Z")).rejects.toThrow(/incomplete/i);
  const banned = harness();
  banned.events.push(sign({ kind: 30047, tags: [["d", "bans"], ["p", worker]] }));
  await expect(banned.tick("2026-09-12T13:00:00Z")).rejects.toThrow(/member|ban/i);
  expect(banned.nostr.publish).not.toHaveBeenCalled();
});


it("continues valid boards after an invalid board and still reports the failure", async () => {
  const h = harness();
  h.settings({ ...review, channelId: "missing", slug: "invalid" }, review);
  await expect(h.tick("2026-09-12T13:00:00Z")).rejects.toThrow(/unavailable|archived/i);
  expect(h.events.filter(e => e.tags.some(t => t[0] === "task" && t[1] === worker))).toHaveLength(1);
});


it("concurrent hosts with independent storage and clocks publish the same daily assignment ID", async () => {
  const first = harness(), second = harness(first.events);
  let arrivals = 0, release!: () => void;
  const bothReading = new Promise<void>(resolve => { release = resolve; });
  for (const h of [first, second]) {
    const query = h.nostr.queryWithStatus;
    h.nostr.queryWithStatus = async filters => {
      const result = await query(filters);
      if (filters.some(f => f["#i"])) {
        if (++arrivals === 2) release();
        await bothReading;
      }
      return result;
    };
  }
  await Promise.all([first.tick("2026-09-12T18:00:00Z"), second.tick("2026-09-12T18:00:01Z")]);
  const delivered = first.events.filter(e => e.tags.some(t => t[0] === "task"));
  expect(delivered).toHaveLength(2);
  expect(new Set(delivered.map(e => e.id)).size).toBe(1);
});
