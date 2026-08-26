import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { FezClient, K, type Wire, type WireEvent, type WireFilter } from "../../fez-client/dist/index.js";

const sk = generateSecretKey();
const pk = getPublicKey(sk);

/**
 * Fake wire mirroring tests/sealed-schedule.test.ts (Task 4), extended
 * with a controllable query/subscribe so a test can hand the client a
 * stored 40007 whose content is JSON.stringify({note, remind_at}) — the
 * fake wire's encrypt/decrypt are identity functions, matching how
 * setReminder encrypts (self-NIP-44) and the client decrypts its own.
 */
function fakeWire(opts: { reminders?: WireEvent[]; deletions?: WireEvent[] } = {}) {
  const subs: { filters: WireFilter[]; onEvent: (event: WireEvent) => void }[] = [];
  const wire = {
    pubkey: pk,
    publish: async (tmpl: never) => ({ ...(tmpl as object), id: "x", pubkey: pk, sig: "", created_at: Math.floor(Date.now() / 1000) }) as unknown as WireEvent,
    subscribe: (filters: WireFilter[], onEvent: (event: WireEvent) => void) => {
      subs.push({ filters, onEvent });
      return () => {};
    },
    query: async (filters: WireFilter[]) => {
      const kinds = new Set(filters.flatMap((f) => f.kinds ?? []));
      if (kinds.has(K.REMINDER)) return opts.reminders ?? [];
      if (kinds.has(K.DELETION)) return opts.deletions ?? [];
      return [];
    },
    encrypt: (_p: string, t: string) => t,
    decrypt: (_p: string, t: string) => t,
    sendDm: async () => "",
    unwrapDm: () => undefined,
    relays: ["ws://test"],
    relayInfo: async () => undefined,
  } as unknown as Wire;
  return { wire, subs };
}

function reminderEvent(id: string, note: string, remindAt: number): WireEvent {
  return {
    id,
    kind: K.REMINDER,
    pubkey: pk,
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify({ note, remind_at: remindAt }),
    tags: [["p", pk]],
    sig: "",
  };
}

function tombstone(id: string, targetId: string): WireEvent {
  return {
    id,
    kind: K.DELETION,
    pubkey: pk,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [["e", targetId]],
    sig: "",
  };
}

describe("client reminder arming", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits reminderDue at remind_at for an own stored reminder", async () => {
    const remindAt = Math.floor(Date.now() / 1000) + 60;
    const { wire } = fakeWire({ reminders: [reminderEvent("rem1", "stretch", remindAt)] });
    const client = new FezClient(wire);
    await client.start();

    const handler = vi.fn();
    client.on("reminderDue", handler as never);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(handler).toHaveBeenCalledWith("stretch");
  });

  it("a tombstoned reminder never fires", async () => {
    const remindAt = Math.floor(Date.now() / 1000) + 60;
    const { wire } = fakeWire({
      reminders: [reminderEvent("rem2", "stretch", remindAt)],
      deletions: [tombstone("del1", "rem2")],
    });
    const client = new FezClient(wire);
    await client.start();

    const handler = vi.fn();
    client.on("reminderDue", handler as never);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a reminder arriving live over subscribe arms too", async () => {
    const { wire, subs } = fakeWire();
    const client = new FezClient(wire);
    await client.start();

    const handler = vi.fn();
    client.on("reminderDue", handler as never);

    const remindAt = Math.floor(Date.now() / 1000) + 60;
    const live = subs.find((s) => s.filters.some((f) => f.kinds?.includes(K.REMINDER)));
    expect(live).toBeDefined();
    live!.onEvent(reminderEvent("rem3", "live one", remindAt));

    await vi.advanceTimersByTimeAsync(61_000);
    expect(handler).toHaveBeenCalledWith("live one");
  });

  it("a reminder beyond setTimeout's cap re-arms instead of firing early", async () => {
    const THIRTY_DAYS_S = 30 * 24 * 60 * 60;
    const MAX_DELAY_MS = 2 ** 31 - 1; // ~24.85 days
    const remindAt = Math.floor(Date.now() / 1000) + THIRTY_DAYS_S;
    const { wire } = fakeWire();
    const client = new FezClient(wire);
    const handler = vi.fn();
    client.on("reminderDue", handler as never);

    // Exercises armReminder directly rather than through client.start():
    // this case targets the chunked re-arm fix in isolation, and start()
    // also spins up the presence/typing intervals, which under fake
    // timers turn a 30-day advance into millions of incidental ticks.
    await (
      client as unknown as { armReminder(event: { id: string; content: string }): Promise<void> }
    ).armReminder(reminderEvent("rem4", "long haul", remindAt));

    // Advancing exactly to the setTimeout cap must NOT fire — the old
    // bug clamped the delay and emitted at the cap, ~5 days early.
    await vi.advanceTimersByTimeAsync(MAX_DELAY_MS);
    expect(handler).not.toHaveBeenCalled();

    // The remainder to the real remind_at fires exactly once.
    const remaining = remindAt * 1000 - Date.now();
    await vi.advanceTimersByTimeAsync(remaining + 1000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("long haul");
  });
});
