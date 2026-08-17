import { beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * THE trust-boundary gate (GAPS.md §2.5). Fez moved Buzz's entire relay
 * ACL layer into client-side trust rules — this suite is the first test
 * coverage that boundary has ever had. A real FezClient runs against a
 * scripted Wire: seeded history hydrates through start(), live events
 * arrive through the captured subscriptions. No relay, no crypto — the
 * client trusts its Wire to have verified signatures, so fabricated
 * events with distinct pubkeys exercise exactly the rules under test.
 */

// Must be set BEFORE the fez-client module loads (module-scope constant).
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fez-trust-")), "communities.json");
process.env.FEZ_STATE_FILE = stateFile;

const { FezClient } = await import("../../fez-client/dist/index.js");
const { installNodeStatePersistence } = await import("../../fez-client/dist/state-node.js");
installNodeStatePersistence(stateFile);
const { matches } = await import("../../fez-relay/dist/relay.js");
type WireEvent = import("../../fez-client/dist/index.js").WireEvent;
type WireFilter = import("../../fez-client/dist/index.js").WireFilter;

const ALICE = "a".repeat(64); // community creator — and the client under test
const BOB = "b".repeat(64); // legitimate member
const MALLORY = "f".repeat(64); // stranger
const COMM = "comm-1";
const CHAN = "chan-1";

let idCounter = 0;
const T0 = Math.floor(Date.now() / 1000) - 3600;

function ev(kind: number, pubkey: string, tags: string[][], content = "", created_at = T0): WireEvent {
  return { id: `ev${String(idCounter++).padStart(4, "0")}`.padEnd(64, "0"), kind, pubkey, created_at, content, tags, sig: "" };
}

class StubWire {
  pubkey = ALICE;
  events: WireEvent[] = [];
  published: WireEvent[] = [];
  private subs: { filters: WireFilter[]; onEvent: (e: WireEvent) => void }[] = [];

  async publish(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    const event = ev(tmpl.kind, this.pubkey, tmpl.tags, tmpl.content, tmpl.created_at ?? Math.floor(Date.now() / 1000));
    this.published.push(event);
    return event;
  }
  subscribe(filters: WireFilter[], onEvent: (e: WireEvent) => void): () => void {
    const sub = { filters, onEvent };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
    };
  }
  async query(filters: WireFilter[]): Promise<WireEvent[]> {
    return this.events.filter((e) => filters.some((f) => matches(e as never, f as never)));
  }
  encrypt(_peer: string, plaintext: string): string {
    return `enc:${plaintext}`;
  }
  decrypt(_peer: string, ciphertext: string): string {
    if (!ciphertext.startsWith("enc:")) throw new Error("not ours");
    return ciphertext.slice(4);
  }
  async sendDm(): Promise<string> {
    return "dm-id";
  }
  unwrapDm(): undefined {
    return undefined;
  }
  /** Deliver a live event to every matching subscription — "the relay fans out". */
  deliver(event: WireEvent): void {
    this.events.push(event);
    for (const sub of [...this.subs]) {
      if (sub.filters.some((f) => matches(event as never, f as never))) sub.onEvent(event);
    }
  }
}

const wire = new StubWire();
let client: InstanceType<typeof FezClient>;

beforeAll(async () => {
  fs.writeFileSync(stateFile, JSON.stringify({ joined: [COMM], lastScope: { communityId: COMM, channelId: CHAN } }));

  // Legitimate world, plus mallory's forgeries, all pre-seeded as history:
  wire.events.push(
    ev(47100, ALICE, [["d", COMM]], JSON.stringify({ name: "Home" })),
    ev(47101, ALICE, [["d", CHAN], ["c", COMM]], JSON.stringify({ name: "general" })),
    ev(47102, ALICE, [["d", CHAN], ["c", COMM], ["p", ALICE], ["p", BOB]], "", T0 + 10),
    // Forgeries — every one of these must be ignored:
    ev(47100, MALLORY, [["d", COMM]], JSON.stringify({ name: "Squatted" }), T0 + 20), // community id squat
    ev(47101, MALLORY, [["d", "evil-chan"], ["c", COMM]], JSON.stringify({ name: "evil" }), T0 + 20), // non-creator channel
    ev(47102, MALLORY, [["d", CHAN], ["c", COMM], ["p", MALLORY]], "", T0 + 30), // non-creator roster (newer!)
    // Message history: one from a member, one from the stranger.
    ev(47103, BOB, [["h", CHAN], ["c", COMM]], "hello from bob", T0 + 40),
    ev(47103, MALLORY, [["h", CHAN], ["c", COMM]], "let me in", T0 + 41)
  );

  client = new FezClient(wire as never);
  await client.start();
});

describe("community trust chain", () => {
  test("first 47100 wins the community id — squatting rejected", () => {
    expect(client.state.communities.get(COMM)?.creator).toBe(ALICE);
    expect(client.state.communities.get(COMM)?.name).toBe("Home");
  });

  test("non-creator 47101 does not create a channel", () => {
    expect(client.state.communities.get(COMM)?.channels.has("evil-chan")).toBe(false);
  });

  test("non-creator 47102 does not override the roster, even when newer", () => {
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(true);
    expect(client.state.isMember(COMM, CHAN, MALLORY)).toBe(false);
  });
});

describe("member gating on messages", () => {
  test("member's message cached; stranger's dropped", () => {
    const contents = client.messages(CHAN).map((m: { content: string }) => m.content);
    expect(contents).toContain("hello from bob");
    expect(contents).not.toContain("let me in");
  });

  test("live message from a non-member is dropped too", () => {
    wire.deliver(ev(47103, MALLORY, [["h", CHAN], ["c", COMM]], "sneaking in live", Math.floor(Date.now() / 1000)));
    expect(client.messages(CHAN).map((m: { content: string }) => m.content)).not.toContain("sneaking in live");
  });
});

describe("latest-wins roster (creator-signed only)", () => {
  test("a newer creator roster removing bob revokes his membership", () => {
    wire.deliver(ev(47102, ALICE, [["d", CHAN], ["c", COMM], ["p", ALICE]], "", T0 + 100));
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(false);
    // and an OLDER creator roster arriving late does not resurrect him
    wire.deliver(ev(47102, ALICE, [["d", CHAN], ["c", COMM], ["p", ALICE], ["p", BOB]], "", T0 + 50));
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(false);
    // restore bob for the tests below
    wire.deliver(ev(47102, ALICE, [["d", CHAN], ["c", COMM], ["p", ALICE], ["p", BOB]], "", T0 + 200));
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(true);
  });
});

describe("author-only edits", () => {
  test("author's 40003 applies; a stranger's is ignored", () => {
    const bobMsg = client.messages(CHAN).find((m: { authorPk: string }) => m.authorPk === BOB)!;
    wire.deliver(ev(40003, MALLORY, [["e", bobMsg.id], ["h", CHAN], ["c", COMM]], "hacked", Math.floor(Date.now() / 1000)));
    expect(client.msgById(bobMsg.id)?.content).toBe("hello from bob");
    wire.deliver(ev(40003, BOB, [["e", bobMsg.id], ["h", CHAN], ["c", COMM]], "hello (edited) from bob", Math.floor(Date.now() / 1000)));
    expect(client.msgById(bobMsg.id)?.content).toBe("hello (edited) from bob");
    expect(client.msgById(bobMsg.id)?.edited).toBe(true);
  });
});

describe("deletion trust rule (author + creator only)", () => {
  test("a stranger's kind 5 is ignored", () => {
    const bobMsg = client.messages(CHAN).find((m: { authorPk: string }) => m.authorPk === BOB)!;
    wire.deliver(ev(5, MALLORY, [["e", bobMsg.id], ["h", CHAN], ["c", COMM]], "", Math.floor(Date.now() / 1000)));
    expect(client.msgById(bobMsg.id)?.deletedBy).toBeUndefined();
  });

  test("the community creator's kind 5 tombstones another member's message as moderator", () => {
    const bobMsg = client.messages(CHAN).find((m: { authorPk: string }) => m.authorPk === BOB)!;
    wire.deliver(ev(5, ALICE, [["e", bobMsg.id], ["h", CHAN], ["c", COMM]], "", Math.floor(Date.now() / 1000)));
    expect(client.msgById(bobMsg.id)?.deletedBy).toBe("moderator");
    expect(client.msgById(bobMsg.id)?.content).toBe("");
  });

  test("an author's kind 5 tombstones their own message as author", () => {
    const live = ev(47103, BOB, [["h", CHAN], ["c", COMM]], "second thoughts", Math.floor(Date.now() / 1000));
    wire.deliver(live);
    expect(client.msgById(live.id)?.content).toBe("second thoughts");
    wire.deliver(ev(5, BOB, [["e", live.id], ["h", CHAN], ["c", COMM]], "", Math.floor(Date.now() / 1000)));
    expect(client.msgById(live.id)?.deletedBy).toBe("author");
  });

  test("same-second roster tie resolves deterministically (lowest id wins)", () => {
    const t = T0 + 300;
    const low: WireEvent = { id: "1".repeat(64), kind: 47102, pubkey: ALICE, created_at: t, content: "", tags: [["d", CHAN], ["c", COMM], ["p", ALICE], ["p", BOB]], sig: "" };
    const high: WireEvent = { id: "9".repeat(64), kind: 47102, pubkey: ALICE, created_at: t, content: "", tags: [["d", CHAN], ["c", COMM], ["p", ALICE]], sig: "" };
    // Arrival order must not matter: higher id first, then lower id...
    wire.deliver(high);
    wire.deliver(low);
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(true); // low id won
    // ...and delivering the higher id again cannot displace the winner.
    wire.deliver({ ...high, id: "9".repeat(63) + "a" });
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(true);
  });

  test("kick republishes the roster without the member, created_at strictly advancing", async () => {
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(true);
    const before = client.state.communities.get(COMM)!.channels.get(CHAN)!.membershipCreatedAt;
    await client.kick(BOB);
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(false);
    const roster = wire.published.at(-1)!;
    expect(roster.kind).toBe(47102);
    expect(roster.created_at).toBeGreaterThan(before); // monotonic bump — no same-second tie
    expect(roster.tags.filter((t) => t[0] === "p").map((t) => t[1])).not.toContain(BOB);
    // the creator cannot remove themselves — the roster roots in their signature
    await expect(client.kick(ALICE)).rejects.toThrow(/creator/);
    // restore bob for the remaining tests
    wire.deliver(ev(47102, ALICE, [["d", CHAN], ["c", COMM], ["p", ALICE], ["p", BOB]], "", Math.floor(Date.now() / 1000) + 10));
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(true);
  });

  test("kind-0 profile names a human; 47000 agent announcement outranks it", () => {
    wire.deliver(ev(0, BOB, [], JSON.stringify({ name: "Bobby" }), Math.floor(Date.now() / 1000)));
    expect(client.displayName(BOB)).toBe("Bobby");
    wire.deliver(ev(30315, BOB, [["d", "general"]], "deep work", Math.floor(Date.now() / 1000)));
    expect(client.statusOf(BOB)).toBe("deep work");
    wire.deliver(ev(47000, BOB, [], JSON.stringify({ name: "bob-agent" }), Math.floor(Date.now() / 1000)));
    expect(client.displayName(BOB)).toBe("bob-agent"); // routing names are load-bearing
  });

  test("canDeleteMessage mirrors the rule for UI gating", () => {
    const bobLive = ev(47103, BOB, [["h", CHAN], ["c", COMM]], "gate check", Math.floor(Date.now() / 1000));
    wire.deliver(bobLive);
    const msg = client.msgById(bobLive.id)!;
    expect(client.canDeleteMessage(COMM, msg)).toBe(true); // client IS the creator
    expect(client.canDeleteMessage("unknown-community", msg)).toBe(false); // not author, no creator standing
  });
});

describe("ban list trust rule (kind 30047)", () => {
  test("a creator ban makes a rostered member a non-member everywhere; forged lists ignored; unban restores", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(true);

    // Mallory forges a ban list banning bob — not the creator, ignored.
    wire.deliver(ev(30047, MALLORY, [["d", COMM], ["p", BOB]], "", now));
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(true);
    expect(client.state.isBanned(COMM, BOB)).toBe(false);

    // The creator bans bob: still on the roster, but a non-member everywhere.
    wire.deliver(ev(30047, ALICE, [["d", COMM], ["p", BOB]], "", now + 1));
    expect(client.state.isBanned(COMM, BOB)).toBe(true);
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(false);
    expect(client.state.communities.get(COMM)!.channels.get(CHAN)!.members.has(BOB)).toBe(true); // roster untouched

    // Banned bob's live message is dropped by the member gate.
    const silenced = ev(47103, BOB, [["h", CHAN], ["c", COMM]], "shouting into the void", now + 2);
    wire.deliver(silenced);
    expect(client.msgById(silenced.id)).toBeUndefined();

    // An OLDER ban list arriving late cannot resurrect a lifted ban...
    wire.deliver(ev(30047, ALICE, [["d", COMM]], "", now + 10)); // creator unbans (empty list)
    expect(client.state.isBanned(COMM, BOB)).toBe(false);
    expect(client.state.isMember(COMM, CHAN, BOB)).toBe(true);
    wire.deliver(ev(30047, ALICE, [["d", COMM], ["p", BOB]], "", now + 5)); // stale ban replayed
    expect(client.state.isBanned(COMM, BOB)).toBe(false);
  });

  test("banUser/unbanUser publish creator-signed lists with advancing created_at", async () => {
    await client.banUser(COMM, BOB);
    const banEvent = wire.published.at(-1)!;
    expect(banEvent.kind).toBe(30047);
    expect(banEvent.tags.filter((t) => t[0] === "p").map((t) => t[1])).toContain(BOB);
    expect(client.state.isBanned(COMM, BOB)).toBe(true);
    await expect(client.banUser(COMM, ALICE)).rejects.toThrow(/creator/);
    await client.unbanUser(COMM, BOB);
    expect(wire.published.at(-1)!.created_at).toBeGreaterThan(banEvent.created_at);
    expect(client.state.isBanned(COMM, BOB)).toBe(false);
  });
});

describe("leaveCommunity", () => {
  test("drops the community locally; scope clears; roster untouched; rejoin restores", async () => {
    expect(client.state.joined.has(COMM)).toBe(true);
    client.state.scope = { communityId: COMM, channelId: CHAN };
    client.leaveCommunity(COMM);
    expect(client.state.joined.has(COMM)).toBe(false);
    expect(client.state.scope).toBeNull();
    // Nothing was published — leaving is local, the roster still lists us.
    expect(wire.published.filter((e) => e.kind === 47102).every((e) => e.tags.some((t) => t[0] === "p" && t[1] === ALICE))).toBe(true);
    expect(client.state.communities.get(COMM)?.channels.get(CHAN)?.members.has(ALICE)).toBe(true);
    // Rejoin restores.
    await client.joinCommunity(COMM);
    expect(client.state.joined.has(COMM)).toBe(true);
  });
});

describe("createChannel (creator-signed only)", () => {
  test("creator publishes 47101 + owner roster; scope moves to the new channel", async () => {
    const before = wire.published.length;
    const channelId = await client.createChannel(COMM, "builds");
    const [chanEvent, rosterEvent] = wire.published.slice(before);
    expect(chanEvent.kind).toBe(47101);
    expect(JSON.parse(chanEvent.content).name).toBe("builds");
    expect(rosterEvent.kind).toBe(47102);
    expect(rosterEvent.tags).toContainEqual(["p", ALICE, "owner"]);
    expect(client.state.scope?.channelId).toBe(channelId);
    expect(client.state.communities.get(COMM)?.channels.get(channelId)?.name).toBe("builds");
  });

  test("non-creator (and unknown community) are refused", async () => {
    client.state.absorb(ev(47100, BOB, [["d", "bobs-comm"]], JSON.stringify({ name: "Bobs" }), T0 + 5));
    await expect(client.createChannel("bobs-comm", "sneak")).rejects.toThrow(/creator/);
    await expect(client.createChannel("no-such", "x")).rejects.toThrow(/unknown/);
  });
});
