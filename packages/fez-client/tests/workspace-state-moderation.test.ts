import { describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { WorkspaceState } from "../src/workspace-state.js";

const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const admin = generateSecretKey();
const adminPk = getPublicKey(admin);
const member = generateSecretKey();
const memberPk = getPublicKey(member);
const troll = generateSecretKey();
const trollPk = getPublicKey(troll);
const now = () => Math.floor(Date.now() / 1000);

const sign = (key: Uint8Array, kind: number, tags: string[][], content = "", created_at = now()) =>
  finalizeEvent({ kind, created_at, tags, content }, key);

/** A fresh workspace with an owner declared and a roster naming an admin + member. */
function seeded(): WorkspaceState {
  const s = new WorkspaceState();
  s.open("ws://test");
  s.describe({ owner: ownerPk });
  s.absorb(sign(owner, 47102, [["d", "roster"], ["p", ownerPk, "owner"], ["p", adminPk, "admin"], ["p", memberPk, "member"]]));
  return s;
}

describe("workspace-state moderation reads", () => {
  test("owner and admin can moderate; a plain member cannot", () => {
    const s = seeded();
    expect(s.canModerate(ownerPk)).toBe(true);
    expect(s.canModerate(adminPk)).toBe(true);
    expect(s.canModerate(memberPk)).toBe(false);
    expect(s.canModerate(trollPk)).toBe(false);
  });

  test("an admin-signed ban is honored by the client", () => {
    const s = seeded();
    expect(s.absorb(sign(admin, 30047, [["d", "bans"], ["p", trollPk]], "", now() + 1))).toBe(true);
    expect(s.isBanned(trollPk)).toBe(true);
  });

  test("a plain member's ban list is ignored by the client", () => {
    const s = seeded();
    expect(s.absorb(sign(member, 30047, [["d", "bans"], ["p", trollPk]], "", now() + 1))).toBe(false);
    expect(s.isBanned(trollPk)).toBe(false);
  });

  test("an expired timeout is not banned; an unexpired one is", () => {
    const s = seeded();
    s.absorb(sign(owner, 30047, [["d", "bans"], ["p", trollPk, String(now() - 5)]], "", now() + 1)); // already expired
    expect(s.isBanned(trollPk)).toBe(false);
    s.absorb(sign(owner, 30047, [["d", "bans"], ["p", trollPk, String(now() + 3600)]], "", now() + 2)); // active
    expect(s.isBanned(trollPk)).toBe(true);
  });

  test("an admin-signed removed list marks the event removed; restore clears it", () => {
    const s = seeded();
    expect(s.absorb(sign(admin, 30047, [["d", "removed"], ["e", "evt-1"]], "", now() + 1))).toBe(true);
    expect(s.isRemoved("evt-1")).toBe(true);
    s.absorb(sign(admin, 30047, [["d", "removed"]], "", now() + 2)); // restore
    expect(s.isRemoved("evt-1")).toBe(false);
  });

  test("a reason rides inside the edict — ban and remove", () => {
    const s = seeded();
    // permanent ban with a reason: until slot holds "" so reason stays positional
    s.absorb(sign(owner, 30047, [["d", "bans"], ["p", trollPk, "", "spam / shill"]], "", now() + 1));
    expect(s.isBanned(trollPk)).toBe(true);
    expect(s.banReason(trollPk)).toBe("spam / shill");
    // timeout + reason
    s.absorb(sign(owner, 30047, [["d", "bans"], ["p", trollPk, String(now() + 3600), "cool off"]], "", now() + 2));
    expect(s.isBanned(trollPk)).toBe(true);
    expect(s.banReason(trollPk)).toBe("cool off");
    // removed with a reason
    s.absorb(sign(admin, 30047, [["d", "removed"], ["e", "evt-9", "scam link"]], "", now() + 3));
    expect(s.removalReason("evt-9")).toBe("scam link");
  });
});
