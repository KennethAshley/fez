import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { matchFilter, type Event, type Filter } from "nostr-tools";
import { z } from "../../fez-memory/node_modules/zod/index.js";

type Result = { content: { type: string; text: string }[] };
type Handler = (input: Record<string, unknown>) => Promise<Result>;
const harness = vi.hoisted(() => ({
  tools: new Map<string, { handler: Handler; schema: z.ZodTypeAny }>(),
  events: [] as Event[], failed: false, secret: new Uint8Array(32).fill(31),
}));
const owner = new Uint8Array(32).fill(30), agent = new Uint8Array(32).fill(31);
const peer = new Uint8Array(32).fill(32), outsider = new Uint8Array(32).fill(33);
const ownerPk = getPublicKey(owner), agentPk = getPublicKey(agent), peerPk = getPublicKey(peer);
const sign = (kind: number, content: string, tags: string[][], key = agent, created_at = 100) =>
  finalizeEvent({ kind, content, tags, created_at }, key);
const memory = (content: string, key = agent, created_at = 100) => sign(47210, content, [["h", "general-id"]], key, created_at);

vi.mock("../../fez-memory/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", () => ({ McpServer: class {
  registerTool(name: string, spec: { inputSchema: z.ZodRawShape }, handler: Handler) {
    harness.tools.set(name, { handler, schema: z.object(spec.inputSchema) });
  }
  async connect() {}
} }));
vi.mock("../../fez-memory/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@fezchat/protocol", async importOriginal => ({
  ...await importOriginal<typeof import("@fezchat/protocol")>(),
  getKey: () => Buffer.from(harness.secret).toString("hex"), resolveRelays: () => ["ws://memory.invalid"],
  fetchRelayInfo: async () => ({ pubkey: ownerPk }),
  pinWorkspaceOwner: (_relay: string, advertised?: string) => advertised,
  RelayConnection: class {
    async connect() {}
    async query(filters: Filter[]) {
      if (harness.failed) return [];
      return [...new Map(filters.flatMap(filter => harness.events.filter(event => matchFilter(filter, event))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, filter.limit))
        .map(event => [event.id, event])).values()];
    }
    async queryWithStatus(filters: Filter[]) {
      return { events: await this.query(filters), failures: harness.failed ? [{ url: "ws://memory.invalid", reason: "timeout" }] : [] };
    }
    async publish(event: Event) {
      if (!verifyEvent(event)) throw new Error("unsigned event");
      harness.events.push(event);
    }
  },
}));

async function call(name: string, input: Record<string, unknown>) {
  const tool = harness.tools.get(name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return (await tool.handler(tool.schema.parse(input))).content.map(item => item.text).join("\n");
}
async function start(key = agent) {
  harness.secret = key;
  harness.tools.clear();
  vi.resetModules();
  await import("../../fez-memory/src/mcp.js");
}
beforeEach(async () => {
  vi.stubEnv("FEZ_AGENT_PERSONA", "memory-test");
  vi.stubEnv("FEZ_EMBED_URL", "");
  harness.failed = false;
  harness.events = [
    sign(47101, JSON.stringify({ name: "general" }), [["d", "general-id"]], owner),
    sign(47102, "", [["d", "roster"], ["p", agentPk, "bot"], ["p", peerPk, "bot"]], owner),
  ];
  await start();
});
afterEach(() => vi.unstubAllEnvs());

describe("shared memory tools", () => {
  it("rejects outsiders, banned authors, removed facts, and forged channel names", async () => {
    const removed = memory("Removed fact");
    harness.events.push(memory("Keep this"), memory("Outsider fact", outsider), memory("Banned fact", peer), removed,
      sign(30047, "", [["d", "bans"], ["p", peerPk]], owner),
      sign(30047, "", [["d", "removed"], ["e", removed.id]], owner),
      sign(47101, JSON.stringify({ name: "general" }), [["d", "forged-id"]], outsider, 200));
    const result = await call("fez_recall", { channel: "general" });
    expect(result).toContain("Keep this");
    expect(result).not.toMatch(/Outsider fact|Banned fact|Removed fact/);
    await call("fez_remember", { channel: "general", text: "Trusted channel" });
    expect(harness.events.at(-1)?.tags).toContainEqual(["h", "general-id"]);
  });

  it("reports a failed read instead of inventing an empty channel", async () => {
    harness.failed = true;
    await expect(call("fez_recall", { channel: "general" })).rejects.toThrow(/incomplete|unavailable|could not/i);
    await expect(call("fez_remember", { channel: "general", text: "Blind write" })).rejects.toThrow();
    expect(harness.events).toHaveLength(2);
  });

  it("refuses tools after the writer loses membership and rejects whitespace input", async () => {
    await expect(call("fez_remember", { channel: "general", text: "   " })).rejects.toThrow();
    harness.events.push(sign(47102, "", [["d", "roster"], ["p", peerPk, "bot"]], owner, 101));
    await expect(call("fez_remember", { channel: "general", text: "Revoked write" })).rejects.toThrow(/member/i);
    await expect(call("fez_recall", { channel: "general" })).rejects.toThrow(/member/i);
    expect(harness.events.some(event => event.kind === 47210)).toBe(false);
  });

  it("a fresh second agent recalls the first agent's corrected fact; forgetting preserves history", async () => {
    await call("fez_remember", { channel: "general", text: "Deploy Fridays" });
    const original = harness.events.at(-1)!;
    await call("fez_remember", { channel: "general", text: "Deploy Mondays", replaces: original.id });
    expect(harness.events.some(event => event.id === original.id && event.content === "Deploy Fridays")).toBe(true);
    await start(peer);
    const result = await call("fez_recall", { channel: "general" });
    expect(result).toContain("Deploy Mondays");
    expect(result).toContain(original.id);
    expect(result).not.toContain("Deploy Fridays");
    await expect(call("fez_remember", { channel: "general", text: "Hijacked", replaces: original.id })).rejects.toThrow(/author|moderator/i);
    await start(agent);
    await call("fez_forget", { channel: "general", memoryId: original.id });
    expect(await call("fez_recall", { channel: "general" })).not.toMatch(/Deploy Fridays|Deploy Mondays/);
    expect(harness.events.filter(event => event.kind === 47210 || event.kind === 47211)).toHaveLength(3);
  });

  it("discloses the history window and hydrates an older fact targeted by a recent correction", async () => {
    const old = memory("Old decision");
    harness.events.push(old, ...Array.from({ length: 501 }, (_, i) => memory(`Recent ${i}`, agent, 200 + i)));
    const miss = await call("fez_recall", { channel: "general", query: "Old decision" });
    expect(miss).toMatch(/older|window|incomplete/i);
    expect(miss).not.toMatch(/no team memory/i);
    await call("fez_remember", { channel: "general", text: "Corrected old decision", replaces: old.id });
    const result = await call("fez_recall", { channel: "general", query: "Corrected" });
    expect(result).toContain("Corrected old decision");
    expect(result).toContain(old.id);
  });

  it("an unauthorized recent correction cannot resurrect an old fact outside the window", async () => {
    const old = memory("Obsolete deployment rule");
    harness.events.push(old,
      sign(47211, "Current deployment rule", [["h", "general-id"], ["e", old.id]], agent, 101),
      ...Array.from({ length: 501 }, (_, i) => memory(`Recent ${i}`, agent, 200 + i)),
      sign(47211, "Forged deployment rule", [["h", "general-id"], ["e", old.id]], peer, 1000));
    const result = await call("fez_recall", { channel: "general", query: "deployment" });
    expect(result).not.toMatch(/Obsolete deployment rule|Forged deployment rule/);
  });
});
