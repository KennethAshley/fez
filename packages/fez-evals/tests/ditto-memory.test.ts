import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDittoServer } from "../../fez-ditto/src/server.js";

const key = "ditto_mcp_test_credential";
let agent: Client;
let server: McpServer;
let status: number;
let rejected: boolean;
let requests: Request[];
let calls: { name: string; arguments: Record<string, unknown> }[];

beforeEach(() => {
  status = 200;
  rejected = false;
  requests = [];
  calls = [];
  // Only the remote HTTP boundary is replaced: both local MCP peers and
  // Ditto's HTTP client perform real protocol initialization and tool calls.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.json();
    if (body.method === "initialize") {
      if (status === 401) return new Response(`Unauthorized: ${key}`, { status });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {
        protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ditto-fixture", version: "1" },
      } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method !== "tools/call") throw new Error(`Unexpected MCP method ${body.method}`);
    calls.push(body.params);
    if (status !== 200) return new Response(`Upstream failed: ${key}`, { status });
    const data = body.params.name === "search_memories"
      ? { results: [{ id: "memory-1", source: "document", preview: "Use short-lived login tokens" }] }
      : body.params.name === "fetch_memories"
        ? { memories: [{ id: "memory-1", content: "Use short-lived login tokens", source: "document" }] }
        : { id: "memory-2", saved: true };
    return Response.json({ jsonrpc: "2.0", id: body.id, result: {
      content: [{ type: "text", text: rejected ? `Denied: ${key}` : JSON.stringify(data) }],
      ...(rejected ? { isError: true } : {}),
    } });
  });
});

afterEach(async () => {
  await agent?.close();
  await server?.close();
  vi.unstubAllGlobals();
});

async function connect(env: NodeJS.ProcessEnv = { DITTO_API_KEY: key }) {
  server = createDittoServer(env);
  agent = new Client({ name: "fez-agent-test", version: "1" });
  const [host, client] = InMemoryTransport.createLinkedPair();
  await server.connect(host);
  await agent.connect(client);
}

it("exposes only memory search, fetch and save without contacting Ditto at startup", async () => {
  await connect();
  const tools = await agent.listTools();
  expect(tools.tools.map(tool => tool.name).sort()).toEqual(["ditto_fetch", "ditto_save", "ditto_search"]);
  expect(requests).toHaveLength(0);
});

it("searches the connected account and preserves source IDs for fetching the full memory", async () => {
  await connect();
  const result = await agent.callTool({ name: "ditto_search", arguments: { query: "  login decision  " } });
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([{ type: "text", text: '{"results":[{"id":"memory-1","source":"document","preview":"Use short-lived login tokens"}]}' }]);
  const fetched = await agent.callTool({ name: "ditto_fetch", arguments: { ids: ["memory-1"] } });
  expect(fetched.content).toEqual([{ type: "text", text: '{"memories":[{"id":"memory-1","content":"Use short-lived login tokens","source":"document"}]}' }]);
  expect(calls).toEqual([
    { name: "search_memories", arguments: { queries: ["login decision"], includePublic: false } },
    { name: "fetch_memories", arguments: { ids: ["memory-1"], format: "full" } },
  ]);
  expect(requests.every(request => request.url === "https://api.heyditto.ai/mcp")).toBe(true);
  expect(requests.every(request => request.redirect === "error")).toBe(true);
  expect(requests.every(request => request.headers.get("authorization") === `Bearer ${key}`)).toBe(true);
});

it("saves only the explicitly supplied note with its Fez source context", async () => {
  await connect();
  const saved = await agent.callTool({ name: "ditto_save", arguments: { content: "  Keep the login flow simple.  ", sourceContext: "Requested in #engineering" } });
  expect(saved.isError).not.toBe(true);
  expect(saved.content).toEqual([{ type: "text", text: '{"id":"memory-2","saved":true}' }]);
  expect(calls).toEqual([{ name: "save_memory", arguments: { content: "Keep the login flow simple.", source: "fez", sourceContext: "Requested in #engineering" } }]);
  for (const request of [
    { name: "ditto_search", arguments: { query: " " } },
    { name: "ditto_fetch", arguments: { ids: [] } },
    { name: "ditto_save", arguments: { content: " " } },
  ]) expect((await agent.callTool(request)).isError).toBe(true);
  expect(calls).toHaveLength(1);
});

it("reports missing credentials and blocks writes during evaluation before any network call", async () => {
  await connect({ FEZ_EVALUATION_ACTIVE: "1" });
  const search = await agent.callTool({ name: "ditto_search", arguments: { query: "login" } });
  expect(search.isError).toBe(true);
  expect(JSON.stringify(search)).toContain("DITTO_API_KEY");
  const save = await agent.callTool({ name: "ditto_save", arguments: { content: "Evaluation should not export this" } });
  expect(save.isError).toBe(true);
  expect(JSON.stringify(save)).toContain("evaluation");
  expect(requests).toHaveLength(0);
});

it("reports authentication and upstream errors without leaking credentials or retrying a save", async () => {
  await connect();
  status = 401;
  const auth = await agent.callTool({ name: "ditto_search", arguments: { query: "login" } });
  expect(auth.isError).toBe(true);
  expect(JSON.stringify(auth)).toMatch(/key|credential/i);
  expect(JSON.stringify(auth)).not.toContain(key);
  status = 200;
  rejected = true;
  const denied = await agent.callTool({ name: "ditto_fetch", arguments: { ids: ["memory-1"] } });
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied)).not.toContain(key);
  status = 500;
  rejected = false;
  const failed = await agent.callTool({ name: "ditto_save", arguments: { content: "One save attempt" } });
  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed)).not.toContain(key);
  expect(JSON.stringify(failed)).toMatch(/search.*again/i);
  expect(calls.filter(call => call.name === "save_memory")).toHaveLength(1);
});
