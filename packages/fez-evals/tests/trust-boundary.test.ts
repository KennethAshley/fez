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

const ALICE = "a".repeat(64); // workspace OWNER — and the client under test
const BOB = "b".repeat(64); // legitimate member
const MALLORY = "f".repeat(64); // stranger
const RELAY = "wss://trust.example"; // the workspace IS this relay
const CHAN = "chan-1";
const ROSTER = "roster";

let idCounter = 0;
const T0 = Math.floor(Date.now() / 1000) - 3600;

/**
 * Roster re-seats need a strictly advancing clock: kick() bumps
 * created_at past the live roster, so any fixed offset goes stale later
 * in the file and silently stops re-seating anyone.
 */
let rosterClock = Math.floor(Date.now() / 1000) + 1000;
const nextRosterTs = () => (rosterClock += 100);

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
  /**
   * The workspace's identity card. ALICE owns it — this single value is
   * the whole root of trust now, where the old model walked a chain
   * from a 47100 to its creator.
   */
  async relayInfo(): Promise<{ name?: string; pubkey?: string }> {
    return { name: "Trust", pubkey: ALICE };
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
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ workspaces: [{ relay: RELAY }], active: RELAY, lastScope: { [RELAY]: CHAN } })
  );

  // Legitimate world, plus mallory's forgeries, all pre-seeded as history:
  wire.events.push(
    ev(47101, ALICE, [["d", CHAN]], JSON.stringify({ name: "general" })),
    ev(47102, ALICE, [["d", ROSTER], ["p", ALICE], ["p", BOB]], "", T0 + 10),
    // Forgeries — every one of these must be ignored:
    ev(47101, MALLORY, [["d", "evil-chan"]], JSON.stringify({ name: "evil" }), T0 + 20), // non-owner channel
    ev(47102, MALLORY, [["d", ROSTER], ["p", MALLORY]], "", T0 + 30), // non-owner roster (newer!)
    ev(47100, MALLORY, [["d", "old-model"]], JSON.stringify({ name: "Squatted" }), T0 + 20), // retired kind
    // Message history: one from a member, one from the stranger.
    ev(47103, BOB, [["h", CHAN]], "hello from bob", T0 + 40),
    ev(47103, MALLORY, [["h", CHAN]], "let me in", T0 + 41)
  );

  client = new FezClient(wire as never);
  await client.start();
});

describe("workspace trust chain", () => {
  test("the retired community kind changes nothing — the relay is the workspace", () => {
    // Mallory's 47100 is a kind that no longer means anything, and the
    // owner comes from NIP-11 rather than from any event she could sign.
    expect(client.state.workspace.owner).toBe(ALICE);
    expect(client.state.workspace.name).toBe("Trust");
  });

  test("non-owner 47101 does not create a channel", () => {
    expect(client.state.workspace.channels.has("evil-chan")).toBe(false);
  });

  test("non-owner 47102 does not override the roster, even when newer", () => {
    expect(client.state.isMember(BOB)).toBe(true);
    expect(client.state.isMember(MALLORY)).toBe(false);
  });
});

describe("member gating on messages", () => {
  test("member's message cached; stranger's dropped", () => {
    const contents = client.messages(CHAN).map((m: { content: string }) => m.content);
    expect(contents).toContain("hello from bob");
    expect(contents).not.toContain("let me in");
  });

  test("live message from a non-member is dropped too", () => {
    wire.deliver(ev(47103, MALLORY, [["h", CHAN]], "sneaking in live", Math.floor(Date.now() / 1000)));
    expect(client.messages(CHAN).map((m: { content: string }) => m.content)).not.toContain("sneaking in live");
  });
});

describe("latest-wins roster (owner-signed only)", () => {
  test("a newer owner roster removing bob revokes his membership", () => {
    wire.deliver(ev(47102, ALICE, [["d", ROSTER], ["p", ALICE]], "", T0 + 100));
    expect(client.state.isMember(BOB)).toBe(false);
    // and an OLDER creator roster arriving late does not resurrect him
    wire.deliver(ev(47102, ALICE, [["d", ROSTER], ["p", ALICE], ["p", BOB]], "", T0 + 50));
    expect(client.state.isMember(BOB)).toBe(false);
    // restore bob for the tests below
    wire.deliver(ev(47102, ALICE, [["d", ROSTER], ["p", ALICE], ["p", BOB]], "", T0 + 200));
    expect(client.state.isMember(BOB)).toBe(true);
  });
});

describe("author-only edits", () => {
  test("author's 40003 applies; a stranger's is ignored", () => {
    const bobMsg = client.messages(CHAN).find((m: { authorPk: string }) => m.authorPk === BOB)!;
    wire.deliver(ev(40003, MALLORY, [["e", bobMsg.id], ["h", CHAN]], "hacked", Math.floor(Date.now() / 1000)));
    expect(client.msgById(bobMsg.id)?.content).toBe("hello from bob");
    wire.deliver(ev(40003, BOB, [["e", bobMsg.id], ["h", CHAN]], "hello (edited) from bob", Math.floor(Date.now() / 1000)));
    expect(client.msgById(bobMsg.id)?.content).toBe("hello (edited) from bob");
    expect(client.msgById(bobMsg.id)?.edited).toBe(true);
  });
});

describe("deletion trust rule (author + owner only)", () => {
  test("a stranger's kind 5 is ignored", () => {
    const bobMsg = client.messages(CHAN).find((m: { authorPk: string }) => m.authorPk === BOB)!;
    wire.deliver(ev(5, MALLORY, [["e", bobMsg.id], ["h", CHAN]], "", Math.floor(Date.now() / 1000)));
    expect(client.msgById(bobMsg.id)?.deletedBy).toBeUndefined();
  });

  test("the workspace owner's kind 5 tombstones another member's message as moderator", () => {
    const bobMsg = client.messages(CHAN).find((m: { authorPk: string }) => m.authorPk === BOB)!;
    wire.deliver(ev(5, ALICE, [["e", bobMsg.id], ["h", CHAN]], "", Math.floor(Date.now() / 1000)));
    expect(client.msgById(bobMsg.id)?.deletedBy).toBe("moderator");
    expect(client.msgById(bobMsg.id)?.content).toBe("");
  });

  test("an author's kind 5 tombstones their own message as author", () => {
    // Re-seat bob: membership is workspace-wide now, so an earlier
    // removal test silences him in every channel, not just one.
    wire.deliver(ev(47102, ALICE, [["d", ROSTER], ["p", ALICE], ["p", BOB]], "", nextRosterTs()));
    const live = ev(47103, BOB, [["h", CHAN]], "second thoughts", Math.floor(Date.now() / 1000));
    wire.deliver(live);
    expect(client.msgById(live.id)?.content).toBe("second thoughts");
    wire.deliver(ev(5, BOB, [["e", live.id], ["h", CHAN]], "", Math.floor(Date.now() / 1000)));
    expect(client.msgById(live.id)?.deletedBy).toBe("author");
  });

  test("same-second roster tie resolves deterministically (lowest id wins)", () => {
    const t = T0 + 300;
    const low: WireEvent = { id: "1".repeat(64), kind: 47102, pubkey: ALICE, created_at: t, content: "", tags: [["d", ROSTER], ["p", ALICE], ["p", BOB]], sig: "" };
    const high: WireEvent = { id: "9".repeat(64), kind: 47102, pubkey: ALICE, created_at: t, content: "", tags: [["d", ROSTER], ["p", ALICE]], sig: "" };
    // Arrival order must not matter: higher id first, then lower id...
    wire.deliver(high);
    wire.deliver(low);
    expect(client.state.isMember(BOB)).toBe(true); // low id won
    // ...and delivering the higher id again cannot displace the winner.
    wire.deliver({ ...high, id: "9".repeat(63) + "a" });
    expect(client.state.isMember(BOB)).toBe(true);
  });

  test("kick republishes the roster without the member, created_at strictly advancing", async () => {
    expect(client.state.isMember(BOB)).toBe(true);
    const before = client.state.workspace.rosterCreatedAt;
    await client.kick(BOB);
    expect(client.state.isMember(BOB)).toBe(false);
    const roster = wire.published.at(-1)!;
    expect(roster.kind).toBe(47102);
    expect(roster.created_at).toBeGreaterThan(before); // monotonic bump — no same-second tie
    expect(roster.tags.filter((t) => t[0] === "p").map((t) => t[1])).not.toContain(BOB);
    // the creator cannot remove themselves — the roster roots in their signature
    await expect(client.kick(ALICE)).rejects.toThrow(/owner/);
    // restore bob for the remaining tests
    wire.deliver(ev(47102, ALICE, [["d", ROSTER], ["p", ALICE], ["p", BOB]], "", nextRosterTs()));
    expect(client.state.isMember(BOB)).toBe(true);
  });

  test("kind-0 profile names a human; 47000 agent announcement outranks it", () => {
    wire.deliver(ev(0, BOB, [], JSON.stringify({ name: "Bobby" }), Math.floor(Date.now() / 1000)));
    expect(client.displayName(BOB)).toBe("Bobby");
    wire.deliver(ev(30315, BOB, [["d", "general"]], "deep work", Math.floor(Date.now() / 1000)));
    expect(client.statusOf(BOB)).toBe("deep work");
    wire.deliver(ev(47000, BOB, [], JSON.stringify({ name: "bob-agent" }), Math.floor(Date.now() / 1000)));
    expect(client.displayName(BOB)).toBe("bob-agent"); // routing names are load-bearing
  });

  test("canDeleteMessage is author-only; the owner withholds others' via canModerateMessage", () => {
    // Re-seat bob: membership is workspace-wide now, so an earlier
    // removal test silences him in every channel, not just one.
    wire.deliver(ev(47102, ALICE, [["d", ROSTER], ["p", ALICE], ["p", BOB]], "", nextRosterTs()));
    const bobLive = ev(47103, BOB, [["h", CHAN]], "gate check", Math.floor(Date.now() / 1000));
    wire.deliver(bobLive);
    const msg = client.msgById(bobLive.id)!;
    // Not the author → no kind-5 self-delete (the relay honors a moderator's
    // kind-5 for nobody), but as the owner they may withhold it as a moderator.
    expect(client.canDeleteMessage(msg)).toBe(false);
    expect(client.canModerateMessage(msg)).toBe(true);
  });
});

describe("ban list trust rule (kind 30047, workspace-wide)", () => {
  test("an owner ban makes a rostered member a non-member everywhere; forged lists ignored; unban restores", () => {
    const now = Math.floor(Date.now() / 1000) + 600;
    wire.deliver(ev(47102, ALICE, [["d", ROSTER], ["p", ALICE], ["p", BOB]], "", now));
    expect(client.state.isMember(BOB)).toBe(true);

    // Mallory forges a ban list banning bob — not the owner, ignored.
    wire.deliver(ev(30047, MALLORY, [["d", "bans"], ["p", BOB]], "", now));
    expect(client.state.isMember(BOB)).toBe(true);
    expect(client.state.isBanned(BOB)).toBe(false);

    // The owner bans bob: still on the roster, but a non-member everywhere.
    wire.deliver(ev(30047, ALICE, [["d", "bans"], ["p", BOB]], "", now + 1));
    expect(client.state.isBanned(BOB)).toBe(true);
    expect(client.state.isMember(BOB)).toBe(false);
    expect(client.state.workspace.members.has(BOB)).toBe(true); // roster untouched

    // Banned bob's live message is dropped by the member gate.
    const silenced = ev(47103, BOB, [["h", CHAN]], "shouting into the void", now + 2);
    wire.deliver(silenced);
    expect(client.msgById(silenced.id)).toBeUndefined();

    // An OLDER ban list arriving late cannot resurrect a lifted ban...
    wire.deliver(ev(30047, ALICE, [["d", "bans"]], "", now + 10)); // owner unbans (empty list)
    expect(client.state.isBanned(BOB)).toBe(false);
    expect(client.state.isMember(BOB)).toBe(true);
    wire.deliver(ev(30047, ALICE, [["d", "bans"], ["p", BOB]], "", now + 5)); // stale ban replayed
    expect(client.state.isBanned(BOB)).toBe(false);
  });

  test("banUser/unbanUser publish owner-signed lists with advancing created_at", async () => {
    await client.banUser(BOB);
    const banEvent = wire.published.at(-1)!;
    expect(banEvent.kind).toBe(30047);
    expect(banEvent.tags.filter((t) => t[0] === "p").map((t) => t[1])).toContain(BOB);
    expect(client.state.isBanned(BOB)).toBe(true);
    await expect(client.banUser(ALICE)).rejects.toThrow(/owner/);
    await client.unbanUser(BOB);
    expect(wire.published.at(-1)!.created_at).toBeGreaterThan(banEvent.created_at);
    expect(client.state.isBanned(BOB)).toBe(false);
  });
});

describe("forgetWorkspace", () => {
  test("drops the workspace from the rail locally; roster untouched", async () => {
    expect(client.workspaces().some((w) => w.relay === RELAY)).toBe(true);
    const publishedBefore = wire.published.length;

    client.forgetWorkspace(RELAY);
    expect(client.workspaces().some((w) => w.relay === RELAY)).toBe(false);

    // Nothing was published — leaving is local, and the owner's roster
    // still lists us. This is what makes re-adding a relay restorative
    // rather than a rejoin request.
    expect(wire.published.length).toBe(publishedBefore);
    expect(client.state.workspace.members.has(ALICE)).toBe(true);
  });
});

describe("createChannel (owner-signed only)", () => {
  test("owner publishes 47101; scope moves to the new channel", async () => {
    const before = wire.published.length;
    const channelId = await client.createChannel("builds");
    const [chanEvent] = wire.published.slice(before);
    expect(chanEvent.kind).toBe(47101);
    expect(JSON.parse(chanEvent.content).name).toBe("builds");
    // No roster event: membership is workspace-wide, so a new channel is
    // already visible to everyone in — the point of the flat model.
    expect(wire.published.slice(before).some((e) => e.kind === 47102)).toBe(false);
    expect(chanEvent.tags).toContainEqual(["d", channelId]);
    expect(client.state.scope?.channelId).toBe(channelId);
    expect(client.state.workspace.channels.get(channelId)?.name).toBe("builds");
  });

  test("a non-owner is refused", async () => {
    // A separate workspace has its own immutable owner.
    const relay = client.state.workspace.relay;
    client.state.open("wss://mallory-workspace.example", undefined, MALLORY);
    await expect(client.createChannel("nope")).rejects.toThrow(/owner/);
    client.state.open(relay);
  });

});
