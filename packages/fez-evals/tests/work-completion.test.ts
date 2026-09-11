import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { matchFilter, type Filter } from "nostr-tools";
import { createRequire } from "node:module";

const state = vi.hoisted(() => ({
  key: "", events: [] as Event[], refuse: false,
  tools: new Map<string, (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>>(),
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
  RelayConnection: class {
    async connect() {}
    async query(filters: Filter[]) { return state.events.filter(e => filters.some(f => matchFilter(f, e))); }
    async publish(event: Event) { if (state.refuse) throw new Error("relay refused"); state.events.push(event); }
  },
}));
const callerKey = new Uint8Array(32).fill(4), workerKey = new Uint8Array(32).fill(5);
const caller = getPublicKey(callerKey), worker = getPublicKey(workerKey);
const request = finalizeEvent({ kind: 47103, created_at: 100, content: "@speaker narrate the script", tags: [
  ["h", "demo"], ["e", "a".repeat(64), "", "reply"], ["p", worker], ["task", worker], ["depth", "1"],
] }, callerKey);
const input = { requestId: request.id, status: "success", summary: "Audio delivered.", capability: "speech", artifacts: ["https://example.org/audio.wav"] };
async function load(key: Uint8Array) {
  vi.resetModules(); state.tools.clear(); state.key = Buffer.from(key).toString("hex");
  vi.stubEnv("FEZ_AGENT_PERSONA", "completion-test");
  await import("../../fez-mcp/src/server.js");
}
afterEach(() => { state.events = []; state.refuse = false; vi.unstubAllEnvs(); });

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
  await complete({ ...input, status: "error", summary: "Speech tool failed", artifacts: [] });
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
