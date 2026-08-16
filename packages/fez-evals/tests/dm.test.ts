import { describe, expect, test } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { buildDmWraps, unwrapDm, KIND_GIFT_WRAP, KIND_DM } from "@fez/protocol";

/**
 * NIP-17 DM gate — the real wrap/unwrap helpers fez ships (src/dm.ts),
 * the same code path CapabilityClient.sendDm, the TUI backend, and the
 * fez-acp agent runtime all go through.
 */

const alice = generateSecretKey();
const bob = generateSecretKey();
const mallory = generateSecretKey();
const alicePk = getPublicKey(alice);
const bobPk = getPublicKey(bob);

describe("NIP-17 DM wrap/unwrap", () => {
  test("round-trips content, sender, and peer through the recipient copy", () => {
    const { toPeer } = buildDmWraps(alice, bobPk, "hello bob");
    expect(toPeer.kind).toBe(KIND_GIFT_WRAP);
    const dm = unwrapDm(toPeer, bob)!;
    expect(dm).toBeDefined();
    expect(dm.text).toBe("hello bob");
    expect(dm.senderPk).toBe(alicePk);
    expect(dm.peerPk).toBe(alicePk); // from bob's side, the peer is alice
    expect(dm.depth).toBe(0);
  });

  test("self-copy unwraps for the sender with peer = recipient", () => {
    const { toSelf } = buildDmWraps(alice, bobPk, "hello bob");
    const dm = unwrapDm(toSelf, alice)!;
    expect(dm.senderPk).toBe(alicePk);
    expect(dm.peerPk).toBe(bobPk); // from alice's side, the peer is bob
    expect(dm.text).toBe("hello bob");
  });

  test("both copies share one rumor id (dedupe key across devices)", () => {
    const { toPeer, toSelf } = buildDmWraps(alice, bobPk, "same rumor");
    expect(unwrapDm(toPeer, bob)!.id).toBe(unwrapDm(toSelf, alice)!.id);
  });

  test("metadata privacy: wrap leaks neither sender nor content", () => {
    const { toPeer } = buildDmWraps(alice, bobPk, "secret text");
    expect(toPeer.pubkey).not.toBe(alicePk); // random one-time key
    expect(toPeer.content).not.toContain("secret text");
    expect(toPeer.tags).toEqual([["p", bobPk]]); // recipient only — no depth tag on the wire
  });

  test("wrap timestamp is fuzzed at-or-before now (subscriptions must window back)", () => {
    const { toPeer } = buildDmWraps(alice, bobPk, "x");
    expect(toPeer.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    // ... while the rumor keeps the real timestamp
    expect(unwrapDm(toPeer, bob)!.ts).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
  });

  test("third party cannot unwrap", () => {
    const { toPeer } = buildDmWraps(alice, bobPk, "not for mallory");
    expect(unwrapDm(toPeer, mallory)).toBeUndefined();
  });

  test("depth rides inside the encrypted rumor (agent loop guard)", () => {
    const { toPeer } = buildDmWraps(alice, bobPk, "agent hop", 3);
    expect(toPeer.tags.some((t) => t[0] === "depth")).toBe(false); // never on the wire
    expect(unwrapDm(toPeer, bob)!.depth).toBe(3);
  });

  test("non-1059 and garbage events are ignorable, not throwing", () => {
    const { toPeer } = buildDmWraps(alice, bobPk, "x");
    expect(unwrapDm({ ...toPeer, kind: KIND_DM }, bob)).toBeUndefined();
    expect(unwrapDm({ ...toPeer, content: "corrupted" }, bob)).toBeUndefined();
  });
});
