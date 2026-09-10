import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowserServer } from "../../fez-browser/src/index.js";

// The boundary fixture mirrors Camofox 1.14.0, observed in the live Verge probe.
const page = "https://www.theverge.com/";
const headline = '- main:\n  - link "A lead story" [e13]:\n    - /url: /tech/123/lead-story';
let http: Server;
let baseUrl: string;
let snapshot: string;
let mode: "ok" | "malformed" | "redirect" | "oversized" | "error";
let requests: { method: string; path: string; userId: string }[];
let sessions: Map<string, Map<string, string>>;
let instances: { client: Client; close: () => Promise<void> }[];

beforeEach(async () => {
  snapshot = headline;
  mode = "ok";
  requests = [];
  sessions = new Map();
  instances = [];
  http = createServer(async (req, res) => {
    const url = new URL(req.url!, baseUrl);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const userId = body.userId ?? url.searchParams.get("userId") ?? url.pathname.split("/")[2];
    requests.push({ method: req.method!, path: url.pathname, userId });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer test-access-key") {
      res.writeHead(401).end('{}'); return;
    }
    if (mode === "redirect") { res.writeHead(302, { Location: `${baseUrl}/stolen` }).end('{}'); return; }
    if (mode === "error") { res.writeHead(503).end('{"error":"upstream unavailable"}'); return; }
    if (mode === "malformed") { res.end('{"unexpected":true}'); return; }
    if (mode === "oversized") { res.end(JSON.stringify({ snapshot: "x".repeat(2 * 1024 * 1024 + 1) })); return; }
    if (req.method === "POST" && url.pathname === "/tabs") {
      if (typeof body.userId !== "string" || body.sessionKey !== body.userId || body.trace !== false) {
        res.writeHead(400).end('{}'); return;
      }
      const tabId = randomUUID();
      const tabs = sessions.get(userId) ?? new Map<string, string>();
      tabs.set(tabId, body.url);
      sessions.set(userId, tabs);
      res.end(JSON.stringify({ tabId, url: body.url })); return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      sessions.delete(userId);
      res.end('{"ok":true}'); return;
    }
    const tabId = url.pathname.split("/")[2];
    const tabs = sessions.get(userId);
    if (!tabs?.has(tabId)) { res.writeHead(404).end('{}'); return; }
    if (req.method === "DELETE") {
      tabs.delete(tabId);
      res.end('{"ok":true}'); return;
    }
    if (url.pathname.endsWith("/snapshot")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      // Upstream returns the FULL text for <=80k, even when an offset is supplied.
      // Larger snapshots have a content window plus the last 5k of navigation links.
      const truncated = snapshot.length > 80_000;
      const hasMore = offset + 74_800 < snapshot.length - 5_000;
      res.end(JSON.stringify({ url: tabs.get(tabId),
        snapshot: truncated ? snapshot.slice(offset, offset + 74_800) + "\n" + snapshot.slice(-5_000) : snapshot,
        refsCount: 1, truncated, totalChars: snapshot.length,
        ...(truncated ? { hasMore, nextOffset: hasMore ? offset + 74_800 : null } : {}) })); return;
    }
    res.writeHead(404).end('{}');
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  mode = "ok";
  for (const instance of instances) {
    await instance.close();
    await instance.client.close();
  }
  http.closeAllConnections();
  await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
});

async function connect(accessKey = "test-access-key", prepare?: () => Promise<void>) {
  const { server, close } = createBrowserServer({ baseUrl, accessKey, prepare });
  const client = new Client({ name: "browser-eval", version: "1.0.0" });
  instances.push({ client, close });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, close };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content;
  if (!Array.isArray(content)) throw new Error("Missing tool content");
  const text = content.filter(item => item.type === "text").map(item => item.text).join("\n");
  return { error: result.isError === true, text };
}

async function open(client: Client) {
  const result = await call(client, "browser_open", { url: page });
  expect(result.error, result.text).toBe(false);
  return JSON.parse(result.text).tab_id as string;
}

describe("fez-browser MCP boundary", () => {
  it("keeps tools available before setup and prepares only for a valid open", async () => {
    let attempts = 0;
    const { client } = await connect("test-access-key", async () => { attempts++; throw new Error("Set up browser in Fez"); });
    expect((await client.listTools()).tools).toHaveLength(3);
    expect(attempts).toBe(0);
    await call(client, "browser_open", { url: "file:///private" });
    expect(attempts).toBe(0);
    const failed = await call(client, "browser_open", { url: page });
    expect(failed).toMatchObject({ error: true, text: "Set up browser in Fez" });
    expect(attempts).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it("reads an article link from the page and closes its owned tab", async () => {
    const { client } = await connect();
    const tab_id = await open(client);
    const read = await call(client, "browser_read", { tab_id });
    expect(read.error).toBe(false);
    expect(read.text).toContain("A lead story");
    expect(read.text).toContain("/tech/123/lead-story");
    expect(read.text).toMatch(/untrusted/i);
    expect((await call(client, "browser_close", { tab_id })).error).toBe(false);
    expect([...sessions.values()][0].size).toBe(0);
    const before = requests.length;
    expect((await call(client, "browser_read", { tab_id })).error).toBe(true);
    expect(requests).toHaveLength(before);
  });

  it("keeps each MCP client's tabs separate and refuses foreign tab IDs", async () => {
    const one = await connect();
    const two = await connect();
    const tab_id = await open(one.client);
    await open(two.client);
    expect(sessions.size).toBe(2);
    const before = requests.length;
    expect((await call(two.client, "browser_read", { tab_id })).error).toBe(true);
    expect((await call(two.client, "browser_close", { tab_id })).error).toBe(true);
    expect(requests).toHaveLength(before);
    expect([...sessions.values()].reduce((sum, tabs) => sum + tabs.size, 0)).toBe(2);
  });

  it("deletes the entire session on shutdown, including unlisted popup tabs", async () => {
    const instance = await connect();
    await open(instance.client);
    [...sessions.values()][0].set("popup", "https://example.com/");
    await instance.close();
    expect(sessions.size).toBe(0);
    const deletes = requests.filter(req => req.method === "DELETE" && req.path.startsWith("/sessions/"));
    expect(deletes).toHaveLength(1);
    await instance.close();
    expect(requests.filter(req => req.path.startsWith("/sessions/"))).toHaveLength(1);
  });

  it("preserves upstream continuation offsets and does not invent cursors for complete pages", async () => {
    snapshot = "a".repeat(74_800) + "THE NEXT ARTICLE" + "b".repeat(10_000) + "f".repeat(5_000);
    const { client } = await connect();
    const tab_id = await open(client);
    const first = await call(client, "browser_read", { tab_id });
    expect(first.text).not.toContain("THE NEXT ARTICLE");
    expect(first.text).toContain('"next_offset":74800');
    const second = await call(client, "browser_read", { tab_id, offset: 74_800 });
    expect(second.text).toContain("THE NEXT ARTICLE");
    expect(second.text).toContain('"next_offset":null');
  });

  it("refuses unsupported and credential-bearing page URLs before making requests", async () => {
    const { client } = await connect();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.com/"]) {
      expect((await call(client, "browser_open", { url })).error).toBe(true);
    }
    expect(requests).toHaveLength(0);
  });

  it("limits open tabs and permits another after one closes", async () => {
    const { client } = await connect();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await open(client));
    expect((await call(client, "browser_open", { url: page })).error).toBe(true);
    expect(requests.filter(req => req.method === "POST")).toHaveLength(4);
    await call(client, "browser_close", { tab_id: ids[0] });
    await open(client);
  });

  it.each(["malformed", "oversized", "error"] as const)("reports %s upstream responses as tool errors", async failure => {
    const { client } = await connect();
    const tab_id = await open(client);
    mode = failure;
    expect((await call(client, "browser_read", { tab_id })).error).toBe(true);
  });

  it("does not follow REST redirects carrying the server access key", async () => {
    const { client } = await connect();
    mode = "redirect";
    const result = await call(client, "browser_open", { url: page });
    expect(result.error).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/tabs");
  });

  it("reports invalid access keys without exposing them", async () => {
    const { client } = await connect("wrong-secret-key");
    const result = await call(client, "browser_open", { url: page });
    expect(result.error).toBe(true);
    expect(result.text).toContain("401");
    expect(result.text).not.toContain("wrong-secret-key");
    await expect(instances[0].close()).rejects.toThrow(/401/);
    instances = [];
    await client.close();
  });

  it("refuses insecure or unauthenticated remote server configurations", () => {
    for (const url of ["http://browser.example/", "file:///tmp/socket", "https://u:p@browser.example/", "https://browser.example/?key=secret"]) {
      expect(() => createBrowserServer({ baseUrl: url, accessKey: "key" })).toThrow();
    }
    expect(() => createBrowserServer({ baseUrl: "https://browser.example/" })).toThrow(/key/i);
  });
});
