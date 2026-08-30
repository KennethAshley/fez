import { beforeEach, describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { FezClient, type WireEvent, type WireFilter } from "../src/index.js";

/**
 * Personal mute — the you-only plane. A self-encrypted 30078 d="mutes"
 * record: hides someone from YOUR view, tells no one, needs no authority,
 * follows your key. Never touches the roster or the relay's policy path.
 */

const me = generateSecretKey();
const mePk = getPublicKey(me);
const bob = generateSecretKey();
const bobPk = getPublicKey(bob);
const CHAN = "mute-chan";
const now = () => Math.floor(Date.now() / 1000);

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
  decrypt(_p: string, c: string): string { if (!c.startsWith("enc:")) throw new Error("not ours"); return c.slice(4); }
  async sendDm(): Promise<string> { return ""; }
  unwrapDm(): undefined { return undefined; }
  async relayInfo(): Promise<{ name?: string; pubkey?: string }> { return { name: "t", pubkey: mePk }; }
}

async function boot(seed: WireEvent[] = []): Promise<{ client: FezClient; wire: StubWire }> {
  const wire = new StubWire();
  wire.events = [
    ev(me, 47101, [["d", CHAN]], JSON.stringify({ name: "general" })),
    ev(me, 47102, [["d", "roster"], ["p", mePk, "owner"], ["p", bobPk, "member"]]),
    ...seed,
  ];
  const client = new FezClient(wire as never);
  await client.start();
  return { client, wire };
}

describe("personal mute", () => {
  let client: FezClient;
  let wire: StubWire;
  beforeEach(async () => {
    ({ client, wire } = await boot());
  });

  test("muting hides their messages from my view only", async () => {
    wire.deliver(ev(bob, 47103, [["h", CHAN]], "hello"));
    expect(client.messages(CHAN).some((m) => m.authorPk === bobPk)).toBe(true);
    await client.mutePerson(bobPk);
    expect(client.isMutedByMe(bobPk)).toBe(true);
    expect(client.messages(CHAN).some((m) => m.authorPk === bobPk)).toBe(false);
    await client.unmutePerson(bobPk);
    expect(client.messages(CHAN).some((m) => m.authorPk === bobPk)).toBe(true);
  });

  test("the mute list publishes self-encrypted — no public p-tags", async () => {
    await client.mutePerson(bobPk);
    const rec = wire.published.find((e) => e.kind === 30078 && e.tags.some((t) => t[0] === "d" && t[1] === "mutes"));
    expect(rec).toBeTruthy();
    expect(rec!.tags.some((t) => t[0] === "p")).toBe(false); // undetectable by the muted
    expect(JSON.parse(rec!.content.slice(4)).muted).toContain(bobPk); // enc: prefix from the stub
  });

  test("mutes hydrate from the relay on start (follows your key)", async () => {
    const stored = ev(me, 30078, [["d", "mutes"]], `enc:${JSON.stringify({ muted: [bobPk] })}`);
    const fresh = await boot([stored]);
    expect(fresh.client.isMutedByMe(bobPk)).toBe(true);
  });

  test("you can't mute yourself", async () => {
    await expect(client.mutePerson(mePk)).rejects.toThrow();
  });
});
