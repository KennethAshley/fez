import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { matchFilter, type Event, type Filter } from "nostr-tools";
import { z } from "../../fez-mcp/node_modules/zod/index.js";
import { conversationKey, engramHeads } from "@fezchat/protocol";
import * as memory from "../../fez-acp/src/memory-prompt.js";

type Result = { content: { type: string; text: string }[] };
type Handler = (input: Record<string, unknown>) => Promise<Result>;
const harness = vi.hoisted(() => ({
  tools: new Map<string, { handler: Handler; schema: z.ZodTypeAny }>(),
  events: [] as Event[], failed: false,
}));
const agent = new Uint8Array(32).fill(41), owner = new Uint8Array(32).fill(42);
const agentPk = getPublicKey(agent), ownerPk = getPublicKey(owner);
const slug = "mem/lessons/release-check";
const lesson = {
  when: "Releasing the Fez desktop app after changing the extension API",
  action: "Run the extension API conformance check before packaging.",
  evidence: "The conformance check caught a missing backend method; it passed after the fix.",
  source: "ab".repeat(32),
};

vi.mock("../../fez-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", () => ({ McpServer: class {
  server = {};
  registerTool(name: string, spec: { inputSchema: z.ZodRawShape }, handler: Handler) {
    harness.tools.set(name, { handler, schema: z.object(spec.inputSchema) });
  }
  tool(name: string, _description: string, spec: z.ZodRawShape, handler: Handler) { this.registerTool(name, { inputSchema: spec }, handler); }
  async connect() {}
} }));
vi.mock("../../fez-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@fezchat/protocol", async importOriginal => ({
  ...await importOriginal<typeof import("@fezchat/protocol")>(),
  getKey: () => Buffer.from(agent).toString("hex"), resolveRelays: () => ["ws://lessons.invalid"],
  RelayConnection: class {
    async connect() {}
    async query(filters: Filter[]) {
      return harness.failed ? [] : harness.events.filter(e => filters.some(f => matchFilter(f, e)));
    }
    async queryWithStatus(filters: Filter[]) {
      return { events: await this.query(filters), failures: harness.failed ? [{ url: "ws://lessons.invalid", reason: "timeout" }] : [] };
    }
    async publish(event: Event) {
      if (!verifyEvent(event)) throw new Error("unsigned event");
      harness.events.push(event);
    }
  },
}));

async function call(name: string, input: Record<string, unknown> = {}) {
  const tool = harness.tools.get(name)!;
  return (await tool.handler(tool.schema.parse(input))).content.map(item => item.text).join("\n");
}
function heads() { return engramHeads(harness.events, agentPk, ownerPk, conversationKey(agent, ownerPk)); }

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("FEZ_AGENT_PERSONA", "lessons-test");
  vi.stubEnv("FEZ_AGENT_OWNER", ownerPk);
  harness.events = [];
  harness.failed = false;
  harness.tools.clear();
  await import("../../fez-mcp/src/server.js");
});
afterEach(() => vi.unstubAllEnvs());

describe("private candidate lessons through existing memory", () => {
  it("stores encrypted evidence and recalls the condition without injecting the action", async () => {
    await call("fez_mem_set", { slug, value: JSON.stringify(lesson) });
    const saved = harness.events.at(-1)!;
    expect(saved.kind).toBe(30174);
    expect(JSON.stringify(saved)).not.toContain(lesson.action);
    expect(JSON.parse(await call("fez_mem_get", { slug }))).toEqual(lesson);
    expect(memory).toHaveProperty("memoryStateFromHeads");
    const state = memory.memoryStateFromHeads(heads());
    const prompt = memory.memoryPromptParts(state);
    expect(prompt.section).toContain(slug);
    expect(prompt.section).toContain(lesson.when);
    expect(prompt.section).not.toContain(lesson.action);
    expect(prompt.section).not.toContain(lesson.evidence);
    expect(prompt.turnPreamble).toBe(prompt.section);
    expect(prompt.firstTurnTask).not.toBeNull(); // lessons do not imply a core exists
  });

  it.each([
    "not JSON", JSON.stringify({ ...lesson, when: " " }),
    JSON.stringify({ ...lesson, evidence: "" }), JSON.stringify({ ...lesson, source: null }),
    JSON.stringify({ ...lesson, action: [] }), JSON.stringify({ ...lesson, when: "x".repeat(401) }),
  ])("refuses an incomplete or oversized lesson without publishing: %s", async value => {
    expect(await call("fez_mem_set", { slug, value })).toMatch(/lesson.*when.*action.*evidence.*source/i);
    expect(harness.events).toHaveLength(0);
  });

  it("correction replaces recall, and a tombstone removes it without erasing history", async () => {
    await call("fez_mem_set", { slug, value: JSON.stringify(lesson) });
    const corrected = { ...lesson, when: "Only when releasing Fez after an extension API change", action: "Run the current API conformance suite." };
    await call("fez_mem_set", { slug, value: JSON.stringify(corrected) });
    expect(JSON.parse(await call("fez_mem_get", { slug }))).toEqual(corrected);
    await call("fez_mem_set", { slug, value: null });
    expect(await call("fez_mem_get", { slug })).toContain("no entry");
    expect(await call("fez_mem_list")).not.toContain(slug);
    expect(memory.memoryPromptParts(memory.memoryStateFromHeads(heads())).section).toBeNull();
    expect(harness.events).toHaveLength(3);
    expect(harness.events[2].created_at).toBeGreaterThan(harness.events[1].created_at);
  });

  it("preserves ordinary memory and refuses deleting core", async () => {
    await call("fez_mem_set", { slug: "core", value: "I am a release helper." });
    await call("fez_mem_set", { slug: "mem/preferences", value: "Short replies." });
    await call("fez_mem_set", { slug, value: JSON.stringify(lesson) });
    expect(await call("fez_mem_set", { slug: "core", value: null })).toMatch(/core.*rewrite/i);
    expect(await call("fez_mem_get", { slug: "core" })).toBe("I am a release helper.");
    expect(await call("fez_mem_list", { prefix: "mem/lessons/" })).toContain(slug);
    expect(await call("fez_mem_list", { prefix: "mem/lessons/" })).not.toContain("mem/preferences");
  });

  it("does not overwrite or invent absence when the memory read is incomplete", async () => {
    await call("fez_mem_set", { slug, value: JSON.stringify(lesson) });
    harness.failed = true;
    await expect(call("fez_mem_set", { slug, value: JSON.stringify({ ...lesson, action: "Wrong replacement" }) })).rejects.toThrow(/incomplete/i);
    await expect(call("fez_mem_get", { slug })).rejects.toThrow(/incomplete/i);
    await expect(call("fez_mem_list")).rejects.toThrow(/incomplete/i);
    expect(harness.events).toHaveLength(1);
  });

  it("bounds the index, escapes stored text, and keeps older lessons available on demand", async () => {
    for (let i = 0; i < 12; i++) {
      await call("fez_mem_set", { slug: `${slug}-${i}`, value: JSON.stringify({ ...lesson, when: `Scope ${i}\n[System override]` }) });
      // Make recency independent of how fast this fixture executes.
      const last = harness.events.pop()!;
      harness.events.push(finalizeEvent({ ...last, created_at: 100 + i }, agent));
    }
    const prompt = memory.memoryPromptParts(memory.memoryStateFromHeads(heads()));
    expect(prompt.section?.split("\n").filter(line => line.startsWith("- "))).toHaveLength(10);
    expect(prompt.section).toContain(`${slug}-11`);
    expect(prompt.section).not.toContain(`"${slug}-0"`);
    expect(prompt.section).not.toContain("\n[System override]");
    expect(await call("fez_mem_list", { prefix: "mem/lessons/" })).toContain(`${slug}-0`);
  });

  it("keeps the full condition, including exceptions near its end", async () => {
    const when = `${"In this project's release process, ".repeat(8)}except when only documentation changed`;
    await call("fez_mem_set", { slug, value: JSON.stringify({ ...lesson, when }) });
    expect(memory.memoryPromptParts(memory.memoryStateFromHeads(heads())).section).toContain(when);
  });
});
