import { beforeEach, describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { FezClient, type WireEvent, type WireFilter } from "../src/index.js";

/**
 * DM metadata channel — reactions, edits, and unsends ride a derived
 * "dm:<pks sorted>" channel while message bodies stay gift-wrapped.
 * These tests cover the client merge rules: author-only edit/unsend,
 * reactions keyed by rumor id, and the derived id itself.
 */

const me = generateSecretKey();
const mePk = getPublicKey(me);
const bob = generateSecretKey();
const bobPk = getPublicKey(bob);
const now = () => Math.floor(Date.now() / 1000);
const DM_ID = "dm:" + [mePk, bobPk].sort().join("+");

const ev = (key: Uint8Array, kind: number, tags: string[][], content = "", created_at = now()) =>
  finalizeEvent({ kind, created_at, tags, content }, key) as WireEvent;

class StubWire {
  pubkey = mePk;
  relays = ["ws://test"];
  events: WireEvent[] = [];
  published: WireEvent[] = [];
  private subs: { onEvent: (e: WireEvent) => void }[] = [];
  async publish(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    const e = ev(me, tmpl.kind, tmpl.tags, tmpl.content, tmpl.created_at ?? now());
    this.published.push(e);
    return e;
  }
  subscribe(_f: WireFilter[], onEvent: (e: WireEvent) => void): () => void {
    const sub = { onEvent };
    this.subs.push(sub);
    return () => { this.subs = this.subs.filter((s) => s !== sub); };
  }
  deliver(e: WireEvent): void { for (const s of this.subs) s.onEvent(e); }
  async query(filters: WireFilter[]): Promise<WireEvent[]> {
    return this.events.filter((e) =>
      filters.some((f) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)))
    );
  }
  encrypt(_p: string, t: string): string { return `enc:${t}`; }
  decrypt(_p: string, c: string): string { return c.slice(4); }
  async sendDm(): Promise<string> { return ""; }
  // Gift wraps in this stub carry their rumor as plain JSON content.
  unwrapDm(e: WireEvent): { id: string; senderPk: string; peerPk: string; text: string; ts: number } | undefined {
    try { return JSON.parse(e.content); } catch { return undefined; }
  }
  async relayInfo(): Promise<{ name?: string; pubkey?: string }> { return { name: "t", pubkey: mePk }; }
}

const RUMOR_ID = "a".repeat(64);

async function boot(): Promise<{ client: FezClient; wire: StubWire }> {
  const wire = new StubWire();
  wire.events = [
    ev(me, 47102, [["d", "roster"], ["p", mePk, "owner"], ["p", bobPk, "member"]]),
  ];
  const client = new FezClient(wire as never);
  await client.start();
  // Bob's rumor lands: one conversation, one message, ids known to both sides.
  wire.deliver(
    ev(bob, 1059, [["p", mePk]], JSON.stringify({ id: RUMOR_ID, senderPk: bobPk, peerPk: mePk, text: "hello", ts: now() }))
  );
  await new Promise((r) => setTimeout(r, 10));
  return { client, wire };
}

describe("dm metadata channel", () => {
  let client: FezClient;
  let wire: StubWire;
  beforeEach(async () => {
    ({ client, wire } = await boot());
  });

  const dmMsg = () => client.dmConversations().get(bobPk)!.msgs[0];

  test("dmChannelId is the sorted full participant set", () => {
    expect(client.dmChannelId(bobPk)).toBe(DM_ID);
  });

  test("a reaction h-tagged to the dm channel lands on the rumor id", () => {
    wire.deliver(ev(bob, 7, [["e", RUMOR_ID], ["h", DM_ID]], "👍"));
    expect(client.reactions(RUMOR_ID)?.get("👍")?.size).toBe(1);
  });

  test("author edit rewrites the rumor; a non-author edit is ignored", () => {
    wire.deliver(ev(me, 40003, [["e", RUMOR_ID], ["h", DM_ID]], "not yours"));
    expect(dmMsg().text).toBe("hello");
    wire.deliver(ev(bob, 40003, [["e", RUMOR_ID], ["h", DM_ID]], "hello, edited"));
    expect(dmMsg().text).toBe("hello, edited");
    expect(dmMsg().edited).toBe(true);
  });

  test("author unsend tombstones; a non-author kind 5 is ignored", () => {
    wire.deliver(ev(me, 5, [["e", RUMOR_ID], ["h", DM_ID]], ""));
    expect(dmMsg().deletedBy).toBeUndefined();
    wire.deliver(ev(bob, 5, [["e", RUMOR_ID], ["h", DM_ID]], ""));
    expect(dmMsg().deletedBy).toBe("author");
    expect(dmMsg().text).toBe("");
  });

  test("my toggleReaction publishes kind 7 into the dm channel", async () => {
    await client.toggleReaction(DM_ID, RUMOR_ID, "🔥");
    const reaction = wire.published.find((e) => e.kind === 7);
    expect(reaction?.tags).toContainEqual(["h", DM_ID]);
    expect(reaction?.tags).toContainEqual(["e", RUMOR_ID]);
  });

  test("editMessage accepts a DM rumor target (no channel Msg exists for it)", async () => {
    // First give ME a message in the convo to edit.
    const myId = "b".repeat(64);
    wire.deliver(
      ev(me, 1059, [["p", mePk]], JSON.stringify({ id: myId, senderPk: mePk, peerPk: bobPk, text: "mine", ts: now() }))
    );
    await new Promise((r) => setTimeout(r, 10));
    await client.editMessage(DM_ID, myId, "mine, fixed");
    const edit = wire.published.find((e) => e.kind === 40003);
    expect(edit?.tags).toContainEqual(["h", DM_ID]);
    const msg = client.dmConversations().get(bobPk)!.msgs.find((m) => m.id === myId)!;
    expect(msg.text).toBe("mine, fixed");
  });

  test("dm reactions never open jobs (👀 is just an emoji here)", () => {
    wire.deliver(ev(bob, 7, [["e", RUMOR_ID], ["h", DM_ID]], "👀"));
    expect(client.activeJobs()).toHaveLength(0);
  });
});
