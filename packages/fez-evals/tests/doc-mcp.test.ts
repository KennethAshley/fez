import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { matchFilter, type Event, type Filter } from "nostr-tools";

type ToolResult = { content: { type: string; text: string }[] };
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;
const harness = vi.hoisted(() => ({ tools: new Map<string, Handler>(), events: [] as Event[] }));
const key = new Uint8Array(32).fill(21), outsider = new Uint8Array(32).fill(22);
const pk = getPublicKey(key);
const sign = (content: string, tags: string[][], kind = 40100, created_at = 100, secret = key) =>
  finalizeEvent({ kind, content, tags, created_at }, secret);

vi.mock("../../fez-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", () => ({ McpServer: class {
  server = {};
  registerTool(name: string, _spec: unknown, handler: Handler) { harness.tools.set(name, handler); }
  tool(name: string, _description: string, spec: unknown, handler: Handler) { this.registerTool(name, spec, handler); }
  async connect() {}
} }));
vi.mock("../../fez-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@fezchat/protocol", async importOriginal => {
  const actual = await importOriginal<typeof import("@fezchat/protocol")>();
  return {
    ...actual, getKey: () => Buffer.from(key).toString("hex"), resolveRelays: () => ["ws://docs.invalid"],
    fetchRelayInfo: async () => ({ pubkey: pk }),
    pinWorkspaceOwner: (_relay: string, advertised?: string) => advertised,
    RelayConnection: class {
      async connect() {}
      async query(filters: Filter[]) { return [...new Map(filters.flatMap(f => harness.events.filter(e => matchFilter(f, e)).sort((a, b) => b.created_at - a.created_at).slice(0, f.limit)).map(e => [e.id, e])).values()]; }
      async queryWithStatus(filters: Filter[]) { return { events: await this.query(filters), failures: [] }; }
      async publish(event: Event) { if (!verifyEvent(event)) throw new Error("unsigned event"); harness.events.push(event); }
    },
  };
});

const call = async (name: string, input: Record<string, unknown>) => {
  const tool = harness.tools.get(name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return (await tool(input)).content.map(item => item.text).join("\n");
};

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("FEZ_AGENT_PERSONA", "docs-test");
  harness.tools.clear();
  harness.events = [sign(JSON.stringify({ name: "docs" }), [["d", "channel-docs"]], 47101)];
  await import("../../fez-mcp/src/server.js");
});
afterEach(() => vi.unstubAllEnvs());

describe("versioned agent document tools", () => {
  it("replies to a listed thread beyond the workspace comment window and orders resolution after its replies", async () => {
    const root = sign("Old page discussion", [["h", "channel-docs"], ["d", "release"]], 40101);
    const marker = sign("", [["h", "channel-docs"], ["d", "release"], ["e", root.id], ["resolved", "1"]], 40101, 2000000000);
    harness.events.push(root, marker, ...Array.from({ length: 500 }, (_, i) => sign(`Unrelated ${i}`, [["h", "channel-docs"], ["d", "other-page"]], 40101, 2000000001 + i)));
    expect(await call("fez_doc_comments", { channel: "docs", page: "release", includeResolved: true })).toContain(root.id);
    await call("fez_comment_reply", { channel: "docs", commentId: root.id, reply: "Reopening", resolve: false });
    expect(harness.events.at(-1)?.content).toBe("Reopening");
    expect(harness.events.at(-1)?.created_at).toBe(marker.created_at + 1);
    expect(harness.events.at(-1)?.tags).toContainEqual(["resolved", "0"]);
  });
  it("replies to a wiki discussion from any workspace channel while keeping channel-doc replies scoped", async () => {
    harness.events.push(sign(JSON.stringify({ name: "elsewhere" }), [["d", "other-channel"]], 47101));
    const root = sign("Review this page", [["h", "channel-docs"], ["d", "release"]], 40101);
    const channelRoot = sign("Only this channel", [["h", "channel-docs"]], 40101);
    harness.events.push(root, channelRoot);
    expect(await call("fez_doc_comments", { channel: "elsewhere", page: "release" })).toContain(root.id);
    await call("fez_comment_reply", { channel: "elsewhere", commentId: root.id, reply: "Reviewed" });
    expect(harness.events.at(-1)?.content).toBe("Reviewed");
    expect(harness.events.at(-1)?.tags).toContainEqual(["h", "channel-docs"]);
    expect(harness.events.at(-1)?.tags).toContainEqual(["d", "release"]);
    expect(await call("fez_comment_reply", { channel: "elsewhere", commentId: channelRoot.id, reply: "Wrong channel" })).toContain("No comment");
    expect(harness.events.at(-1)?.content).toBe("Reviewed");
  });
  it("returns the exact read version and refuses an intervening edit without publication", async () => {
    const first = sign("Original", [["h", "channel-docs"], ["d", "release"], ["title", "Release Notes"]]);
    harness.events.push(first);
    expect(await call("fez_wiki_read", { channel: "docs", page: "release" })).toContain(first.id);
    const newer = sign("Human edit", [["h", "channel-docs"], ["d", "release"], ["base", first.id]], 40100, 101);
    harness.events.push(newer);
    await expect(call("fez_wiki_write", { channel: "docs", page: "release", markdown: "Stale replacement" })).rejects.toThrow(/version|changed/i);
    expect(harness.events.filter(e => e.kind === 40100).map(e => e.content)).toEqual(["Original", "Human edit"]);
  });
  it("requires an observed or explicit base for replacement and preserves titles", async () => {
    const first = sign("Original", [["h", "channel-docs"], ["d", "release"], ["title", "Release Notes"]]);
    harness.events.push(first);
    await expect(call("fez_wiki_write", { channel: "docs", page: "release", markdown: "Blind" })).rejects.toThrow(/version|read/i);
    await call("fez_wiki_write", { channel: "docs", page: "release", markdown: "Updated", baseId: first.id });
    expect(harness.events.at(-1)).toMatchObject({ content: "Updated", pubkey: pk });
    expect(harness.events.at(-1)?.tags).toContainEqual(["title", "Release Notes"]);
    expect(harness.events.at(-1)?.tags).toContainEqual(["base", first.id]);
  });
  it("edits one exact match, rejects ambiguous or stale changes, and returns the signed version", async () => {
    const first = sign("Keep\nFix this\nKeep", [["h", "channel-docs"]]);
    harness.events.push(first);
    expect(await call("fez_doc_get", { channel: "docs" })).toContain(first.id);
    await expect(call("fez_doc_edit", { channel: "docs", baseId: first.id, before: "Keep", after: "Drop" })).rejects.toThrow(/unique|ambiguous/i);
    const result = await call("fez_doc_edit", { channel: "docs", baseId: first.id, before: "Fix this", after: "Fixed" });
    const next = harness.events.at(-1)!;
    expect(next.content).toBe("Keep\nFixed\nKeep");
    expect(result).toContain(next.id);
    await expect(call("fez_doc_edit", { channel: "docs", baseId: first.id, before: "Fixed", after: "Lost" })).rejects.toThrow(/version|changed/i);
  });
  it("ignores untrusted heads and follows base chains within the same second", async () => {
    const first = sign("Original", [["h", "channel-docs"]]);
    const next = sign("Second", [["h", "channel-docs"], ["base", first.id]]);
    const forged = sign("Outsider", [["h", "channel-docs"]], 40100, 9999999999, outsider);
    harness.events.push(first, next, forged);
    const result = await call("fez_doc_get", { channel: "docs" });
    expect(result).toContain(next.id);
    expect(result).toContain("Second");
    expect(result).not.toContain("Outsider");
  });
  it("shows reopened threads with authors and excludes wiki notes from channel docs", async () => {
    const root = sign("Please edit", [["h", "channel-docs"]], 40101);
    harness.events.push(root,
      sign("Done", [["h", "channel-docs"], ["e", root.id], ["resolved", "1"]], 40101, 101),
      sign("", [["h", "channel-docs"], ["e", root.id], ["resolved", "0"]], 40101, 102),
      sign("Wiki only", [["h", "channel-docs"], ["d", "release"]], 40101));
    const result = await call("fez_doc_comments", { channel: "docs" });
    expect(result).toContain(root.id);
    expect(result).toContain(pk);
    expect(result).toContain("Please edit");
    expect(result).toContain("Done");
    expect(result).not.toContain("Wiki only");
  });
});
