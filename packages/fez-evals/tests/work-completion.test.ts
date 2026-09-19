import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { matchFilter, type Filter } from "nostr-tools";
import { createRequire } from "node:module";

const state = vi.hoisted(() => ({
  dir: "", key: "", events: [] as Event[], refuse: false,
  tools: new Map<string, (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>>(),
}));
vi.mock("../../../src/shared/durable-work.js", async original => ({
  ...await original<typeof import("../../../src/shared/durable-work.js")>(),
  workDirectory: () => state.dir,
}));
const requireMcp = createRequire(new URL("../../fez-mcp/src/server.ts", import.meta.url));
vi.doMock(requireMcp.resolve("@modelcontextprotocol/sdk/server/mcp.js").replace("/dist/cjs/", "/dist/esm/"), () => ({ McpServer: class {
  server = {};
  tool() {}
  registerTool(name: string, _schema: unknown, handler: Parameters<typeof state.tools.set>[1]) { state.tools.set(name, handler); }
  async connect() {}
} }));
vi.mock("@fezchat/protocol", async importOriginal => ({
  ...await importOriginal<typeof import("@fezchat/protocol")>(),
  getKey: () => state.key, resolveRelays: () => ["ws://controlled.invalid"],
  fetchRelayInfo: async () => ({ pubkey: getPublicKey(new Uint8Array(32).fill(6)) }),
  pinWorkspaceOwner: (_url: string, advertised?: string) => advertised,
  RelayConnection: class {
    async connect() {}
    async query(filters: Filter[]) {
      return [...new Map(filters.flatMap(filter => state.events.filter(e => matchFilter(filter, e))
        .sort((a, b) => b.created_at - a.created_at).slice(0, filter.limit ?? Infinity)).map(event => [event.id, event])).values()];
    }
    async queryWithStatus(filters: Filter[]) { return { events: await this.query(filters), failures: [] }; }
    async publish(event: Event) { if (state.refuse) throw new Error("relay refused"); state.events.push(event); }
  },
}));
const callerKey = new Uint8Array(32).fill(4), workerKey = new Uint8Array(32).fill(5);
const caller = getPublicKey(callerKey), worker = getPublicKey(workerKey);
const ownerKey = new Uint8Array(32).fill(6), owner = getPublicKey(ownerKey);
const request = finalizeEvent({ kind: 47103, created_at: 100, content: "@speaker narrate the script", tags: [
  ["h", "demo"], ["e", "a".repeat(64), "", "reply"], ["p", worker], ["task", worker], ["depth", "1"],
] }, callerKey);
const input = { requestId: request.id, status: "success", summary: "Audio delivered.", capability: "speech", artifacts: ["https://example.org/audio.wav"] };
async function load(key: Uint8Array) {
  if (!state.dir) state.dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-work-tool-"));
  vi.resetModules(); state.tools.clear(); state.key = Buffer.from(key).toString("hex");
  vi.stubEnv("FEZ_AGENT_PERSONA", "completion-test");
  vi.stubEnv("FEZ_AGENT_OWNER", owner);
  await import("../../fez-mcp/src/server.js");
}
afterEach(() => { if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true }); state.dir = ""; state.events = []; state.refuse = false; vi.unstubAllEnvs(); });

function workspace() {
  state.events.push(
    finalizeEvent({ kind: 47102, created_at: 100, content: "", tags: [["d", "roster"], ["p", owner, "owner"], ["p", caller, "bot"], ["p", worker, "bot"]] }, ownerKey),
    finalizeEvent({ kind: 47101, created_at: 100, content: '{"name":"demo"}', tags: [["d", "demo"]] }, ownerKey),
    finalizeEvent({ kind: 47000, created_at: 100, content: '{"name":"speaker","aliases":["voice"]}', tags: [] }, workerKey),
    finalizeEvent({ kind: 47006, created_at: 100, content: "", tags: [["p", worker]] }, ownerKey),
  );
}

it("sends a compact tool handoff with the source thread, assigned worker, and retry identity", async () => {
  workspace();
  const source = finalizeEvent({ kind: 47103, created_at: 100, content: "PRIVATE_LONG_HISTORY_DO_NOT_COPY", tags: [["h", "demo"]] }, ownerKey);
  state.events.push(source);
  await load(callerKey);
  const send = state.tools.get("fez_send_message")!;
  const message = "@voice Task: narrate the approved script. Facts: use the linked script. Constraints: no edits. Return: audio URL. References: " + source.id;
  expect((await send({ channel: "demo", message, replyTo: source.id })).isError).not.toBe(true);
  const sent = state.events.at(-1)!;
  expect(verifyEvent(sent)).toBe(true);
  expect(sent.content).toBe(message);
  expect(sent.content).not.toContain(source.content);
  expect(sent.tags).toEqual(expect.arrayContaining([["h", "demo"], ["e", source.id, "", "reply"], ["p", worker], ["task", worker], ["depth", "1"]]));
  await send({ channel: "demo", message, replyTo: source.id });
  expect(state.events.filter(e => e.id === sent.id)).toHaveLength(1);
});

it("refuses handoffs without a source, oversized briefs, unknown recipients, and cross-channel parents", async () => {
  workspace();
  state.events.push(request);
  const elsewhere = finalizeEvent({ ...request, tags: [["h", "other"]] }, callerKey);
  state.events.push(elsewhere);
  await load(callerKey);
  const send = state.tools.get("fez_send_message")!;
  for (const input of [
    { message: "@speaker do work" },
    { message: "@speaker " + "x".repeat(4000), replyTo: request.id },
    { message: "@unknown do work", replyTo: request.id },
    { message: "@speaker do work", replyTo: elsewhere.id },
  ]) expect((await send({ channel: "demo", ...input })).isError).toBe(true);
  expect(state.events.filter(e => e.created_at > 100)).toHaveLength(0);
});

it("rejects a duplicate recipient even when another member has over 200 recent announcements", async () => {
  workspace();
  const source = finalizeEvent({ kind: 47103, created_at: 100, content: "source", tags: [["h", "demo"]] }, ownerKey);
  state.events.push(source, finalizeEvent({ kind: 47000, created_at: 100, content: '{"name":"speaker"}', tags: [] }, ownerKey));
  for (let i = 0; i < 201; i++) state.events.push(finalizeEvent({ kind: 47000, created_at: 200 + i, content: '{"name":"speaker"}', tags: [] }, workerKey));
  await load(callerKey);
  const reply = await state.tools.get("fez_send_message")!({ channel: "demo", message: "@speaker narrate this", replyTo: source.id });
  expect(reply.isError).toBe(true);
  expect(reply.content[0].text).toContain("2 workspace members");
  expect(state.events.some(e => e.pubkey === caller && e.kind === 47103)).toBe(false);
});

it("reuses a saved tool handoff after a failed publish and MCP restart", async () => {
  workspace();
  const source = finalizeEvent({ kind: 47103, created_at: 100, content: "source", tags: [["h", "demo"]] }, ownerKey);
  state.events.push(source);
  const input = { channel: "demo", replyTo: source.id, message: "@speaker narrate this" };
  await load(callerKey); state.refuse = true;
  expect((await state.tools.get("fez_send_message")!(input)).isError).toBe(true);
  const { DurableWork } = await import("../../../src/shared/durable-work.js");
  const [saved] = new DurableWork(state.dir).pendingHandoffs();
  expect(saved).toBeDefined();
  state.refuse = false; await load(callerKey);
  expect((await state.tools.get("fez_send_message")!(input)).isError).not.toBe(true);
  expect(state.events.filter(e => e.id === saved.id)).toHaveLength(1);
  expect(new DurableWork(state.dir).pendingHandoffs()).toEqual([]);
});

it("reads only a requested message excerpt and refuses a non-member's reference", async () => {
  workspace();
  const source = finalizeEvent({ kind: 47103, created_at: 100, content: "x".repeat(4500) + "TAIL", tags: [["h", "demo"]] }, ownerKey);
  const outsider = finalizeEvent({ ...source, content: "OUTSIDER" }, new Uint8Array(32).fill(7));
  state.events.push(source, outsider);
  await load(callerKey);
  const read = state.tools.get("fez_read_message");
  expect(read).toBeDefined();
  const excerpt = JSON.parse((await read!({ id: source.id, offset: 0, limit: 2000 })).content[0].text);
  expect(excerpt).toMatchObject({ id: source.id, content: "x".repeat(2000), nextOffset: 2000, totalCharacters: 4504 });
  const tail = JSON.parse((await read!({ id: source.id, offset: 4500, limit: 2000 })).content[0].text);
  expect(tail).toMatchObject({ content: "TAIL", nextOffset: null });
  expect((await read!({ id: outsider.id })).isError).toBe(true);
});

it("publishes one signed result and a separate requester-signed acceptance linked to its work", async () => {
  state.events = [request];
  await load(workerKey);
  expect(state.tools.has("fez_complete_work")).toBe(true);
  const complete = state.tools.get("fez_complete_work")!;
  expect((await complete(input)).isError).not.toBe(true);
  const result = state.events.at(-1)!;
  expect(verifyEvent(result)).toBe(true);
  expect(result.pubkey).toBe(worker);
  expect(result.tags).toEqual(expect.arrayContaining([
    ["result", request.id], ["status", "success"], ["p", caller], ["e", request.id, "", "reply"],
    ["artifact", "https://example.org/audio.wav"], ["e", "a".repeat(64), "", "root"],
  ]));
  await complete(input);
  expect(state.events).toHaveLength(2);
  expect(state.events.some(e => e.kind === 47007)).toBe(false);
  const badAcceptance = await state.tools.get("fez_accept_work")!({ resultId: result.id, note: "I accept myself" });
  expect(badAcceptance.isError).toBe(true);
  await load(callerKey);
  const accept = state.tools.get("fez_accept_work")!;
  expect((await accept({ resultId: result.id, note: "Checked the supplied audio against the requested script." })).isError).not.toBe(true);
  const chit = state.events.at(-1)!;
  expect(verifyEvent(chit)).toBe(true);
  expect(chit.kind).toBe(47007);
  expect(chit.pubkey).toBe(caller);
  expect(chit.tags).toEqual(expect.arrayContaining([["p", worker], ["e", result.id], ["task", request.id], ["capability", "speech"]]));
  await accept({ resultId: result.id, note: "Checked again" });
  expect(state.events).toHaveLength(3);
});

it("rejects unassigned work, invalid artifacts, and acceptance of a blocker; publish errors stay errors", async () => {
  state.events = [request];
  await load(callerKey);
  expect(state.tools.has("fez_complete_work")).toBe(true);
  expect((await state.tools.get("fez_complete_work")!(input)).isError).toBe(true);
  await load(workerKey);
  const complete = state.tools.get("fez_complete_work")!;
  expect((await complete({ ...input, artifacts: ["javascript:alert(1)"] })).isError).toBe(true);
  state.refuse = true;
  expect((await complete(input)).isError).toBe(true);
  expect(state.events).toHaveLength(1);
  state.refuse = false;
  const blockedRequest = finalizeEvent({ kind: 47103, created_at: 102, content: "another job", tags: request.tags }, callerKey);
  state.events.push(blockedRequest);
  await complete({ ...input, requestId: blockedRequest.id, status: "error", summary: "Speech tool failed", artifacts: [] });
  const result = state.events.at(-1)!;
  await load(callerKey);
  expect((await state.tools.get("fez_accept_work")!({ resultId: result.id, note: "Accept" })).isError).toBe(true);
  expect(state.events.some(e => e.kind === 47007)).toBe(false);
});

it("carries the requester's external result handler into the signed specialist result", async () => {
  const assignment = finalizeEvent({ kind: 47103, created_at: 101, content: request.content,
    tags: [...request.tags, ["result-handler", "external"]] }, callerKey);
  state.events = [assignment];
  await load(workerKey);
  expect((await state.tools.get("fez_complete_work")!({ ...input, requestId: assignment.id })).isError).not.toBe(true);
  const result = state.events.at(-1)!;
  expect(verifyEvent(result)).toBe(true);
  expect(result.tags).toContainEqual(["result-handler", "external"]);
  expect(result.tags).toContainEqual(["result", assignment.id]);
});

 it("retries the exact signed result after an ambiguous publish across MCP restart", async () => {
  state.events = [request]; await load(workerKey);
  state.refuse = true;
  expect((await state.tools.get("fez_complete_work")!(input)).isError).toBe(true);
  const files = fs.readdirSync(path.join(state.dir, "outbox"));
  const saved = JSON.parse(fs.readFileSync(path.join(state.dir, "outbox", files[0]), "utf8"));
  await load(workerKey); state.refuse = false;
  await state.tools.get("fez_complete_work")!({ ...input, summary: "different retry text" });
  expect(state.events.at(-1)?.id).toBe(saved.id);
  expect(state.events.at(-1)?.content).toBe(input.summary);
});
