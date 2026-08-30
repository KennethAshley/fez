import { describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { FezClient, type WireEvent, type WireFilter } from "../src/index.js";

/**
 * The shared moderation queue. Reports fan out one-per-moderator (each
 * NIP-44'd to that mod), and resolution is DERIVED: a removed target or a
 * banned author means "handled"; only Dismiss writes its own edict
 * (30047 d=dismissed — the same signed-list machinery as bans).
 */

const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const adminSk = generateSecretKey();
const adminPk = getPublicKey(adminSk);
const member = generateSecretKey();
const memberPk = getPublicKey(member);
const troll = generateSecretKey();
const trollPk = getPublicKey(troll);
const CHAN = "queue-chan";
const now = () => Math.floor(Date.now() / 1000);

const ev = (key: Uint8Array, kind: number, tags: string[][], content = "", created_at = now()) =>
  finalizeEvent({ kind, created_at, tags, content }, key) as WireEvent;

class StubWire {
  pubkey: string;
  key: Uint8Array;
  relays = ["ws://test"];
  events: WireEvent[] = [];
  published: WireEvent[] = [];
  private subs: { onEvent: (e: WireEvent) => void }[] = [];
  constructor(key: Uint8Array) { this.key = key; this.pubkey = getPublicKey(key); }
  async publish(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    const e = ev(this.key, tmpl.kind, tmpl.tags, tmpl.content, tmpl.created_at ?? now());
    this.published.push(e);
    this.events.push(e);
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
      filters.some((f) => {
        if (f.kinds && !f.kinds.includes(e.kind)) return false;
        if (f.authors && !f.authors.includes(e.pubkey)) return false;
        const pWant = (f as Record<string, string[]>)["#p"];
        if (pWant && !e.tags.some((t) => t[0] === "p" && pWant.includes(t[1]))) return false;
        return true;
      })
    );
  }
  // "encryption": enc:<recipient>:<plaintext> — decrypt only works for the holder.
  encrypt(peer: string, t: string): string { return `enc:${peer}:${t}`; }
  decrypt(_peer: string, c: string): string {
    const [, recipient, ...rest] = c.split(":");
    if (recipient !== this.pubkey) throw new Error("not addressed to me");
    return rest.join(":");
  }
  async sendDm(): Promise<string> { return ""; }
  unwrapDm(): undefined { return undefined; }
  async relayInfo(): Promise<{ name?: string; pubkey?: string }> { return { name: "t", pubkey: ownerPk }; }
}

const roster = () =>
  ev(owner, 47102, [["d", "roster"], ["p", ownerPk, "owner"], ["p", adminPk, "admin"], ["p", memberPk, "member"], ["p", trollPk, "member"]]);

async function boot(key: Uint8Array, seed: WireEvent[] = []): Promise<{ client: FezClient; wire: StubWire }> {
  const wire = new StubWire(key);
  wire.events = [ev(owner, 47101, [["d", CHAN]], JSON.stringify({ name: "general" })), roster(), ...seed];
  const client = new FezClient(wire as never);
  await client.start();
  return { client, wire };
}

/** A member's report events for one target — one per moderator, as reportMessage produces. */
function seededReports(targetId: string): WireEvent[] {
  const body = JSON.stringify({ reason: "spam", author: trollPk });
  return [ownerPk, adminPk].map((mod) =>
    ev(member, 1984, [["p", mod], ["e", targetId], ["h", CHAN]], `enc:${mod}:${body}`)
  );
}

describe("moderation queue", () => {
  test("reportMessage fans out one encrypted event per moderator", async () => {
    const { client, wire } = await boot(member);
    await client.reportMessage(CHAN, "evt-1", trollPk, "spam");
    const reports = wire.published.filter((e) => e.kind === 1984);
    expect(reports).toHaveLength(2); // owner + admin
    const recipients = reports.map((r) => r.tags.find((t) => t[0] === "p")?.[1]).sort();
    expect(recipients).toEqual([ownerPk, adminPk].sort());
    for (const r of reports) {
      expect(r.tags).toContainEqual(["e", "evt-1"]);
      expect(r.tags).toContainEqual(["h", CHAN]);
      const to = r.tags.find((t) => t[0] === "p")![1];
      expect(r.content.startsWith(`enc:${to}:`)).toBe(true); // encrypted to THAT moderator
    }
  });

  test("a moderator's queue groups reports by target and decrypts reasons", async () => {
    const { client } = await boot(adminSk, seededReports("evt-1"));
    const entries = await client.listReports();
    expect(entries).toHaveLength(1);
    expect(entries[0].targetId).toBe("evt-1");
    expect(entries[0].channelId).toBe(CHAN);
    expect(entries[0].authorPk).toBe(trollPk);
    expect(entries[0].reporters).toHaveLength(1); // one reporter (their copy addressed to me)
    expect(entries[0].reporters[0].reason).toBe("spam");
    expect(entries[0].resolved).toBeUndefined();
  });

  test("removing the target resolves the entry for every moderator", async () => {
    const { client } = await boot(adminSk, seededReports("evt-2"));
    await client.removeMessage("evt-2", "spam");
    const entries = await client.listReports();
    expect(entries[0].resolved?.action).toBe("removed");
    expect(entries[0].resolved?.by).toBe(adminPk); // the signer of the removed list
  });

  test("banning the author resolves the entry", async () => {
    const { client } = await boot(adminSk, seededReports("evt-3"));
    await client.banUser(trollPk, undefined, "spam");
    const entries = await client.listReports();
    expect(entries[0].resolved?.action).toBe("banned");
  });

  test("dismiss writes its own edict and resolves without touching content", async () => {
    const { client, wire } = await boot(adminSk, seededReports("evt-4"));
    await client.dismissReport("evt-4");
    const dis = wire.published.find((e) => e.kind === 30047 && e.tags.some((t) => t[1] === "dismissed"));
    expect(dis?.tags).toContainEqual(["e", "evt-4"]);
    const entries = await client.listReports();
    expect(entries[0].resolved?.action).toBe("dismissed");
  });

  test("a plain member cannot read the queue", async () => {
    const { client } = await boot(member, seededReports("evt-5"));
    const entries = await client.listReports();
    expect(entries).toHaveLength(0); // nothing addressed to a non-moderator decrypts
  });
});
