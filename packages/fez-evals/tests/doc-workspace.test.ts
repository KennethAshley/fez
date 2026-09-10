import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools";
import * as docs from "../../fez-client/src/index.js";
import type { Wire, WireEvent, WireFilter } from "../../fez-client/src/index.js";

const key = new Uint8Array(32).fill(11), strangerKey = new Uint8Array(32).fill(12);
const pk = getPublicKey(key);
const channel = "docs-channel";
const signed = (kind: number, content: string, tags: string[][], created_at = 100, secret = key) =>
  finalizeEvent({ kind, content, tags, created_at }, secret);

function fixture() {
  const events: WireEvent[] = [];
  const subscriptions = new Set<{ filters: WireFilter[]; receive: (e: WireEvent) => void }>();
  const deliver = (event: WireEvent) => {
    if (!verifyEvent(event)) return;
    events.push(event);
    for (const sub of subscriptions) if (sub.filters.some(f => matchFilter(f, event))) sub.receive(event);
  };
  const wire: Wire = {
    pubkey: pk,
    publish: async tmpl => {
      const event = signed(tmpl.kind, tmpl.content, tmpl.tags, tmpl.created_at ?? Math.floor(Date.now() / 1000));
      events.push(event); // Deliberately no echo: local updates must still appear.
      return event;
    },
    query: async filters => events.filter(e => filters.some(f => matchFilter(f, e))),
    subscribe: (filters, receive) => {
      const sub = { filters, receive }; subscriptions.add(sub);
      return () => { subscriptions.delete(sub); };
    },
    encrypt: (_pk, text) => text, decrypt: (_pk, text) => text,
    sendDm: async () => "", unwrapDm: () => undefined,
    relays: ["ws://docs.invalid"],
    relayInfo: async () => ({ pubkey: pk }),
  };
  const client = new docs.FezClient(wire);
  client.state.describe({ owner: pk });
  events.push(signed(docs.K.CHANNEL, JSON.stringify({ name: "docs", visibility: "open" }), [["d", channel]]));
  return { client, wire, events, deliver };
}

beforeEach(() => {
  vi.useFakeTimers();
  docs.setStatePersistence({ exists: () => false, read: () => undefined, write: () => {} });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("document selection anchors", () => {
  it("distinguishes equal quotes by context and relocates after insertions above", () => {
    const content = "first: same quote.\nsecond: same quote.";
    const anchor = docs.createDocAnchor(content, 27, 37);
    expect(anchor.text).toBe("same quote");
    expect(docs.locateDocAnchor("Intro\n" + content, anchor)).toEqual({ start: 33, end: 43 });
  });
  it("leaves ambiguous, removed, and invalid selections unattached", () => {
    expect(docs.locateDocAnchor("same same", { text: "same", prefix: "", suffix: "" })).toBeUndefined();
    expect(docs.locateDocAnchor("gone", { text: "same", prefix: "", suffix: "" })).toBeUndefined();
    expect(() => docs.createDocAnchor("text", 3, 2)).toThrow();
  });
  it("does not attach a deleted duplicate to the remaining quote", () => {
    const anchor = docs.createDocAnchor("first: same quote.\nsecond: same quote.", 27, 37);
    expect(docs.locateDocAnchor("first: same quote.", anchor)).toBeUndefined();
  });
  it("keeps rewritten text between unique surrounding contexts attached, but not deletions", () => {
    const anchor = docs.createDocAnchor("Above.\nOriginal.\nBelow.", 7, 16);
    expect(docs.locateDocAnchor("Above.\nRewritten section.\nBelow.", anchor)).toEqual({ start: 7, end: 25 });
    expect(docs.locateDocAnchor("Above.\n\nBelow.", anchor)).toBeUndefined();
    expect(docs.locateDocAnchor("Above.\nOne.\nBelow.\nAbove.\nTwo.\nBelow.", anchor)).toBeUndefined();
  });
});

describe("signed collaborative documents", () => {
  it("keeps a page's address when its display title changes", async () => {
    const { client } = fixture();
    const first = await client.publishWikiDoc(channel, "release-checklist", "# Release Process");
    const title = client.wikiDocs().get("release-checklist")!.title;
    expect(title).toBe("Release Process");
    const next = await client.publishWikiDoc(channel, title, "# Release Process\n\nUpdated", first.id, "release-checklist");
    expect(next.tags).toContainEqual(["d", "release-checklist"]);
    expect(next.tags).toContainEqual(["title", title]);
    expect((await client.wikiVersions("release-checklist")).at(-1)?.id).toBe(next.id);
    expect(await client.wikiVersions("release-process")).toEqual([]);
  });
  it.each([false, true])("updates summaries when an arrival makes a different cached branch current (wiki: %s)", async wiki => {
    const { client, deliver } = fixture();
    await client.start();
    const tags = [["h", channel], ...(wiki ? [["d", "branches"]] : [])];
    const now = Math.floor(Date.now() / 1000);
    const a = signed(docs.K.DOC, "A", tags, now + 30);
    const c = signed(docs.K.DOC, "C", tags, now + 25);
    const b = signed(docs.K.DOC, "B", [...tags, ["base", a.id]], now + 20);
    deliver(a); deliver(c); deliver(b);
    const versions = wiki ? await client.wikiVersions("branches") : await client.docVersions(channel);
    expect(versions.at(-1)?.content).toBe("C");
    expect((wiki ? client.wikiDocs().get("branches") : client.docsByChannel().get(channel))?.latestContent).toBe("C");
  });
  it("returns signed versions, publishes local changes, and refuses stale or missing bases", async () => {
    const { client, events } = fixture();
    const changes: string[] = [];
    client.on("docChanged", id => changes.push(id));
    const first = await client.publishDoc(channel, "one");
    expect(first?.id).toBeTruthy();
    expect(verifyEvent(first)).toBe(true);
    expect(changes).toEqual([channel]);
    await expect(client.publishDoc(channel, "blind")).rejects.toThrow(/stale|changed|version/i);
    const next = await client.publishDoc(channel, "two", first.id);
    await expect(client.publishDoc(channel, "stale", first.id)).rejects.toThrow(/stale|changed|version/i);
    expect(events.filter(e => e.kind === docs.K.DOC).map(e => e.content)).toEqual(["one", "two"]);
    expect((await client.docVersions(channel)).at(-1)?.id).toBe(next.id);
    expect(client.docsByChannel().get(channel)?.latestId).toBe(next.id);
  });
  it("protects named pages and does not accept outsiders as a new base", async () => {
    const { client, events } = fixture();
    const first = await client.publishWikiDoc(channel, "Release Notes", "one");
    expect(first?.id).toBeTruthy();
    events.push(signed(docs.K.DOC, "forged head", [["d", "release-notes"], ["h", channel]], 9999999999, strangerKey));
    await expect(client.publishWikiDoc(channel, "Release Notes", "blind")).rejects.toThrow();
    const second = await client.publishWikiDoc(channel, "Release Notes", "two", first.id);
    expect((await client.wikiVersions("release-notes")).at(-1)?.id).toBe(second.id);
  });
  it("refuses incomplete reads and keeps local versions visible before relay query catches up", async () => {
    const { client, wire, events } = fixture();
    wire.queryWithStatus = async () => ({ events: [], failures: [{ url: "ws://docs.invalid", reason: "timeout" }] });
    await expect(client.publishDoc(channel, "unsafe")).rejects.toThrow(/read|retry/i);
    expect(events.some(e => e.kind === docs.K.DOC)).toBe(false);
    wire.queryWithStatus = async () => ({ events: [], failures: [] });
    const first = await client.publishDoc(channel, "one");
    await expect(client.publishDoc(channel, "blind")).rejects.toThrow();
    await client.publishDoc(channel, "two", first.id);
    expect((await client.docVersions(channel)).map(e => e.content)).toEqual(["one", "two"]);
  });
  it("keeps locally published comments readable before relay queries catch up", async () => {
    const { client, wire } = fixture();
    wire.query = async () => [];
    const root = await client.publishDocComment(channel, "please edit");
    await client.publishDocComment(channel, "", { parentId: root.id, resolve: true });
    await client.publishDocComment(channel, "", { parentId: root.id, resolve: false });
    expect(await client.docComments({ channelId: channel })).toMatchObject([{ id: root.id, resolved: false }]);
  });
  it("keeps live document summaries on the causal tip even when clocks disagree", async () => {
    const { client, deliver } = fixture();
    await client.start();
    const now = Math.floor(Date.now() / 1000);
    const first = signed(docs.K.DOC, "First", [["h", channel]], now + 10);
    const next = signed(docs.K.DOC, "Second", [["h", channel], ["base", first.id]], now);
    deliver(next);
    deliver(first);
    expect((await client.docVersions(channel)).at(-1)?.id).toBe(next.id);
    expect(client.docsByChannel().get(channel)?.latestId).toBe(next.id);
  });
  it("round-trips anchors and writer, resolves and reopens a stable root, and isolates page comments", async () => {
    const { client } = fixture();
    const anchorContext = { text: "same", prefix: "before ", suffix: " after" };
    const root = await client.publishDocComment(channel, "please edit", { anchor: "same", anchorContext, writerPk: pk });
    expect(root?.id).toBeTruthy();
    expect(verifyEvent(root)).toBe(true);
    await client.publishDocComment(channel, "wiki only", { slug: "notes" });
    await client.publishDocComment(channel, "done", { parentId: root.id, resolve: true });
    expect((await client.docComments({ channelId: channel }))[0].resolved).toBe(true);
    await client.publishDocComment(channel, "", { parentId: root.id, resolve: false });
    const threads = await client.docComments({ channelId: channel });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: root.id, anchorContext, writerPk: pk, resolved: false });
    expect(threads[0].replies.map(r => r.text)).toEqual(["done"]);
    expect(await client.docComments({ slug: "notes" })).toHaveLength(1);
  });
  it("notifies signed live and local comments but rejects nonmembers and malformed signatures", async () => {
    const { client, deliver } = fixture();
    await client.start();
    const changes: string[] = [];
    client.on("docCommentsChanged", id => changes.push(id));
    const now = Math.floor(Date.now() / 1000);
    const remote = signed(docs.K.DOC_COMMENT, "remote", [["h", channel]], now);
    deliver(remote);
    deliver(remote);
    deliver(signed(docs.K.DOC_COMMENT, "outsider", [["h", channel]], now, strangerKey));
    deliver(JSON.parse(JSON.stringify({ ...signed(docs.K.DOC_COMMENT, "invalid", [["h", channel]], now), sig: "invalid" })));
    await client.publishDocComment(channel, "local");
    expect(changes).toEqual([channel, channel]);
    expect((await client.docComments({ channelId: channel })).map(t => t.text).sort()).toEqual(["local", "remote"]);
  });
});
