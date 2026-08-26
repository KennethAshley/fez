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
});
