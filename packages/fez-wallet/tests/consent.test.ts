import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  buildConsentRequest,
  awaitDecision,
  type ConsentRelay,
  type SignedNostrEvent,
} from "../src/consent.js";

const agentSk = bytesToHex(generateSecretKey());
const ownerSk = generateSecretKey();
const ownerPk = getPublicKey(ownerSk);
const strangerSk = generateSecretKey();

function fakeRelay() {
  const handlers: ((ev: SignedNostrEvent) => void)[] = [];
  const relay: ConsentRelay = {
    publish: async () => {},
    subscribe: (_filter, onEvent) => {
      handlers.push(onEvent);
      return () => {};
    },
    query: async () => [],
  };
  return { relay, emit: (ev: SignedNostrEvent) => handlers.forEach((h) => h(ev)) };
}

// A minimal reaction event; sig is not checked by awaitDecision (the
// relay filter + pubkey check is the trust rule), so a stub sig is fine.
function reaction(content: string, pubkey: string, targetId: string): SignedNostrEvent {
  return { id: "r1", kind: 7, pubkey, content, tags: [["e", targetId]], created_at: 0, sig: "00" };
}

describe("consent", () => {
  it("builds a valid signed 47103 request", () => {
    const ev = buildConsentRequest({
      agentSecretHex: agentSk,
      channelId: "chan1",
      ownerPk,
      text: "scout requests 0.5 TAO → 5Dest",
    });
    expect(ev.kind).toBe(47103);
    expect(ev.tags).toContainEqual(["h", "chan1"]);
    expect(ev.tags).toContainEqual(["p", ownerPk]);
    expect(verifyEvent(ev)).toBe(true);
  });

  it("resolves approved on owner ✅", async () => {
    const { relay, emit } = fakeRelay();
    const p = awaitDecision(relay, "req1", ownerPk, 5000);
    emit(reaction("✅", ownerPk, "req1"));
    await expect(p).resolves.toBe("approved");
  });

  it("resolves declined on owner ❌", async () => {
    const { relay, emit } = fakeRelay();
    const p = awaitDecision(relay, "req1", ownerPk, 5000);
    emit(reaction("❌", ownerPk, "req1"));
    await expect(p).resolves.toBe("declined");
  });

  it("ignores non-owner reactions and times out", async () => {
    const { relay, emit } = fakeRelay();
    const p = awaitDecision(relay, "req1", ownerPk, 50);
    emit(reaction("✅", getPublicKey(strangerSk), "req1")); // wrong signer
    emit(reaction("✅", ownerPk, "other-event"));           // wrong target
    emit(reaction("🎉", ownerPk, "req1"));                  // wrong emoji
    await expect(p).resolves.toBe("timeout");
  });

  it("resolves aborted immediately when the signal is already aborted", async () => {
    const { relay } = fakeRelay();
    const controller = new AbortController();
    controller.abort();
    const p = awaitDecision(relay, "req1", ownerPk, 5000, controller.signal);
    await expect(p).resolves.toBe("aborted");
  });

  it("abort before approval wins — a late reaction cannot flip an already-aborted wait", async () => {
    const { relay, emit } = fakeRelay();
    const controller = new AbortController();
    const p = awaitDecision(relay, "req1", ownerPk, 5000, controller.signal);
    controller.abort();
    emit(reaction("✅", ownerPk, "req1")); // arrives too late — must not resolve "approved"
    await expect(p).resolves.toBe("aborted");
  });
});
