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

  async publish(tmpl: { kind: number; tags: string[][]; content: string }): Promise<WireEvent> {
    const event = ev(tmpl.kind, this.pubkey, tmpl.tags, tmpl.content, Math.floor(Date.now() / 1000));
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

  test("canDeleteMessage mirrors the rule for UI gating", () => {
    const bobLive = ev(47103, BOB, [["h", CHAN], ["c", COMM]], "gate check", Math.floor(Date.now() / 1000));
    wire.deliver(bobLive);
    const msg = client.msgById(bobLive.id)!;
    expect(client.canDeleteMessage(COMM, msg)).toBe(true); // client IS the creator
    expect(client.canDeleteMessage("unknown-community", msg)).toBe(false); // not author, no creator standing
  });
});
