import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { sealContent } from "../../../src/protocol/intents.js";
import { activateScheduler } from "../../fez-relay/src/scheduler.js";

const sk = generateSecretKey();
const now = () => Math.floor(Date.now() / 1000);

function sealedIntent(sendAt: number, text = "hello future") {
  const inner = finalizeEvent({ kind: 47103, created_at: sendAt, tags: [["h", "chan1"]], content: text }, sk);
  const intent = finalizeEvent(
    { kind: 40006, created_at: now(), tags: [["h", "chan1"], ["send_at", String(sendAt)]], content: sealContent(inner) },
    sk
  );
  return { inner, intent };
}

function fakeApi(stored: unknown[] = []) {
  const injected: unknown[] = [];
  const observers: ((e: never) => void)[] = [];
  return {
    injected,
    emit: (e: unknown) => observers.forEach((cb) => cb(e as never)),
    api: {
      query: (filter: Record<string, unknown>) => {
        const kinds = filter.kinds as number[] | undefined;
        return stored.filter((e) => !kinds || kinds.includes((e as { kind: number }).kind)) as never[];
      },
      onEvent: (cb: (e: never) => void) => observers.push(cb),
      inject: async (e: never) => { injected.push(e); return { accepted: true }; },
      log: () => {},
    },
  };
}

describe("relay scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms a stored sealed intent and injects the embedded event at send_at", async () => {
    const { inner, intent } = sealedIntent(now() + 60);
    const { api, injected } = fakeApi([intent]);
    activateScheduler(api);
    expect(injected).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(injected).toHaveLength(1);
    const inj = injected[0] as typeof inner;
    expect(inj.id).toBe(inner.id);
    expect(inj.kind).toBe(inner.kind);
    expect(inj.pubkey).toBe(inner.pubkey);
    expect(inj.content).toBe(inner.content);
    expect(inj.tags).toEqual(inner.tags);
    expect(inj.sig).toBe(inner.sig);
  });

  it("fires overdue intents immediately on activate", async () => {
    const { inner, intent } = sealedIntent(now() - 100);
    const { api, injected } = fakeApi([intent]);
    activateScheduler(api);
    await vi.advanceTimersByTimeAsync(1);
    expect(injected).toHaveLength(1);
    const inj = injected[0] as typeof inner;
    expect(inj.id).toBe(inner.id);
    expect(inj.kind).toBe(inner.kind);
    expect(inj.pubkey).toBe(inner.pubkey);
    expect(inj.content).toBe(inner.content);
    expect(inj.tags).toEqual(inner.tags);
    expect(inj.sig).toBe(inner.sig);
  });

  it("arms live intents arriving after activate", async () => {
    const { api, injected, emit } = fakeApi([]);
    activateScheduler(api);
    const { inner, intent } = sealedIntent(now() + 30);
    emit(intent);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(injected).toHaveLength(1);
    const inj = injected[0] as typeof inner;
    expect(inj.id).toBe(inner.id);
    expect(inj.kind).toBe(inner.kind);
    expect(inj.pubkey).toBe(inner.pubkey);
    expect(inj.content).toBe(inner.content);
    expect(inj.tags).toEqual(inner.tags);
    expect(inj.sig).toBe(inner.sig);
  });

  it("a tombstoned intent never fires; a live tombstone disarms", async () => {
    const { intent } = sealedIntent(now() + 60);
    const tomb = finalizeEvent({ kind: 5, created_at: now(), tags: [["e", intent.id]], content: "" }, sk);
    const stored = fakeApi([intent, tomb]);
    activateScheduler(stored.api);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(stored.injected).toHaveLength(0);

    const live = fakeApi([]);
    activateScheduler(live.api);
    const second = sealedIntent(now() + 60);
    live.emit(second.intent);
    live.emit(finalizeEvent({ kind: 5, created_at: now(), tags: [["e", second.intent.id]], content: "" }, sk));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(live.injected).toHaveLength(0);
  });

  it("legacy plaintext intents are ignored (sentinel territory)", async () => {
    const legacy = finalizeEvent(
      { kind: 40006, created_at: now(), tags: [["h", "chan1"], ["send_at", String(now() + 10)]], content: "plain text" },
      sk
    );
    const { api, injected } = fakeApi([legacy]);
    activateScheduler(api);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(injected).toHaveLength(0);
  });

  it("only tombstones from the intent's own author disarm it", async () => {
    const { inner, intent } = sealedIntent(now() + 30);
    const strangerTomb = finalizeEvent({ kind: 5, created_at: now(), tags: [["e", intent.id]], content: "" }, generateSecretKey());
    const { api, injected } = fakeApi([intent, strangerTomb]);
    activateScheduler(api);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(injected).toHaveLength(1);
    const inj = injected[0] as typeof inner;
    expect(inj.id).toBe(inner.id);
    expect(inj.kind).toBe(inner.kind);
    expect(inj.pubkey).toBe(inner.pubkey);
    expect(inj.content).toBe(inner.content);
    expect(inj.tags).toEqual(inner.tags);
    expect(inj.sig).toBe(inner.sig);
  });
});
