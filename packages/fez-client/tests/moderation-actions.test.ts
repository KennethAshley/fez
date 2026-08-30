import { beforeEach, describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { FezClient, type Wire, type WireEvent } from "../src/index.js";

const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const adminSk = generateSecretKey();
const adminPk = getPublicKey(adminSk);
const memberPk = getPublicKey(generateSecretKey());
const trollPk = getPublicKey(generateSecretKey());
const now = () => Math.floor(Date.now() / 1000);

/** A wire that signs+records as a chosen key, and serves a claimed workspace. */
function fakeWire(key: Uint8Array): { wire: Wire; published: WireEvent[] } {
  const published: WireEvent[] = [];
  const wire: Wire = {
    pubkey: getPublicKey(key),
    relays: ["ws://test"],
    async publish(tmpl) {
      const e = finalizeEvent({ ...tmpl, created_at: tmpl.created_at ?? now() }, key) as WireEvent;
      published.push(e);
      return e;
    },
    subscribe: () => () => {},
    async query() { return []; },
    encrypt: (_p, t) => t,
    decrypt: (_p, c) => c,
    async sendDm() { return ""; },
    unwrapDm: () => undefined,
    async relayInfo() { return { name: "test", pubkey: ownerPk } as any; },
  };
  return { wire, published };
}

/** Seed a client's state: owner declared, roster names an admin + member. */
function seed(client: FezClient) {
  client.state.describe({ owner: ownerPk });
  client.state.absorb(
    finalizeEvent(
      { kind: 47102, created_at: now(), tags: [["d", "roster"], ["p", ownerPk, "owner"], ["p", adminPk, "admin"], ["p", memberPk, "member"]], content: "" },
      owner
    )
  );
}

describe("moderation actions", () => {
  let ownerClient: FezClient;
  let ownerPub: WireEvent[];
  beforeEach(() => {
    const f = fakeWire(owner);
    ownerClient = new FezClient(f.wire);
    ownerPub = f.published;
    seed(ownerClient);
  });

  test("banUser publishes a 30047 d=bans naming the target", async () => {
    await ownerClient.banUser(trollPk);
    const ban = ownerPub.find((e) => e.kind === 30047);
    expect(ban?.tags).toContainEqual(["d", "bans"]);
    expect(ban?.tags).toContainEqual(["p", trollPk]);
  });

  test("banUser with until writes a timeout tag", async () => {
    const until = now() + 3600;
    await ownerClient.banUser(trollPk, until);
    const ban = ownerPub.find((e) => e.kind === 30047);
    expect(ban?.tags).toContainEqual(["p", trollPk, String(until)]);
  });

  test("removeMessage publishes a 30047 d=removed naming the event", async () => {
    await ownerClient.removeMessage("evt-99");
    const rem = ownerPub.find((e) => e.kind === 30047);
    expect(rem?.tags).toContainEqual(["d", "removed"]);
    expect(rem?.tags).toContainEqual(["e", "evt-99"]);
  });

  test("reasons travel inside the signed edict", async () => {
    await ownerClient.banUser(trollPk, undefined, "spam");
    const ban = ownerPub.find((e) => e.kind === 30047 && e.tags.some((t) => t[1] === "bans"));
    expect(ban?.tags).toContainEqual(["p", trollPk, "", "spam"]);
    await ownerClient.removeMessage("evt-77", "scam link");
    const rem = ownerPub.find((e) => e.kind === 30047 && e.tags.some((t) => t[1] === "removed"));
    expect(rem?.tags).toContainEqual(["e", "evt-77", "scam link"]);
  });

  test("promote republishes the roster with role=admin", async () => {
    await ownerClient.promote(memberPk);
    const roster = ownerPub.find((e) => e.kind === 47102);
    expect(roster?.tags).toContainEqual(["p", memberPk, "admin"]);
  });

  test("an admin cannot ban the owner or another admin", async () => {
    const f = fakeWire(adminSk);
    const adminClient = new FezClient(f.wire);
    seed(adminClient);
    await expect(adminClient.banUser(ownerPk)).rejects.toThrow(/owner/);
    await expect(adminClient.banUser(adminPk)).rejects.toThrow(/admin/);
    await adminClient.banUser(trollPk); // a plain target is fine
    expect(f.published.some((e) => e.kind === 30047)).toBe(true);
  });

  test("a plain member cannot moderate", async () => {
    const memberSk = generateSecretKey();
    const f = fakeWire(memberSk);
    // roster marks this key a plain member
    const mClient = new FezClient(f.wire);
    mClient.state.describe({ owner: ownerPk });
    mClient.state.absorb(
      finalizeEvent(
        { kind: 47102, created_at: now(), tags: [["d", "roster"], ["p", ownerPk, "owner"], ["p", getPublicKey(memberSk), "member"]], content: "" },
        owner
      )
    );
    await expect(mClient.banUser(trollPk)).rejects.toThrow(/moderator/);
  });
});
