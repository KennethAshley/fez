import { expect, it } from "vitest";
import type { Event, Filter } from "nostr-tools";
import { workHistory } from "../../fez-acp/src/work-history.js";

it("delivers available dense history but cannot certify an uncapped timestamp", async () => {
  const events = Array.from({ length: 450 }, (_, i) => ({ id: String(i), created_at: i < 430 ? 10 : 9 } as Event));
  const received: string[] = [];
  await expect(workHistory(async ([filter]: Filter[]) => ({ failures: [], events: events.filter(e => e.created_at <= (filter.until ?? Infinity)).slice(0, filter.limit) }),
    { since: 0 }, async event => { received.push(event.id); })).rejects.toThrow(/capped/);
  expect(new Set(received).size).toBe(450);
  expect(received).toHaveLength(450);
});

it("does not skip a relay's middle pages when another relay returns older events", async () => {
  const events = Array.from({ length: 600 }, (_, i) => ({ id: String(i), created_at: 600 - i } as Event));
  const received: string[] = [];
  await workHistory(async ([filter]: Filter[]) => ({ failures: [], events: [
    ...events.slice(0, 450).filter(e => e.created_at <= (filter.until ?? Infinity)).slice(0, filter.limit),
    ...events.slice(450).filter(e => e.created_at <= (filter.until ?? Infinity)).slice(0, filter.limit),
  ] }), { since: 0 }, async event => { received.push(event.id); });
  expect(new Set(received).size).toBe(600);
});

it("refuses to certify a partial history read", async () => {
  await expect(workHistory(async () => ({ events: [], failures: [{ reason: "timeout" }] }), {}, async () => {})).rejects.toThrow(/incomplete/);
});

it("retains the checkpoint when a relay caps a saturated timestamp page", async () => {
  const events = Array.from({ length: 450 }, (_, i) => ({ id: String(i), created_at: 10 } as Event));
  await expect(workHistory(async () => ({ events: events.slice(0, 200), failures: [] }), {}, async () => {})).rejects.toThrow(/capped/);
});


it.each([false, true])("retains the checkpoint at a hidden1000-event cap (second relay: %s)", async mixed => {
  const first = Array.from({ length: 1500 }, (_, i) => ({ id: String(i), created_at: 10 } as Event));
  const second = mixed ? Array.from({ length: 20 }, (_, i) => ({ id: `other${i}`, created_at: 9 } as Event)) : [];
  await expect(workHistory(async ([filter]) => ({ failures: [], events: [
    ...first.filter(e => e.created_at <= (filter.until ?? Infinity)).slice(0, Math.min(1000, filter.limit!)),
    ...second.filter(e => e.created_at <= (filter.until ?? Infinity)).slice(0, filter.limit),
  ] }), { since: 0 }, async () => {})).rejects.toThrow(/capped/);
});
