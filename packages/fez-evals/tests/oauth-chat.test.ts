import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { CONNECTIONS, connectService, freshToken, readConnection } from "../../../src/extensions/connections.js";
import { registerConnectionTools } from "../../fez-mcp/src/connections.js";

// Only the OS credential store and machine settings are replaced. Discovery,
// registration, PKCE, browser redirects and token exchange use real HTTP.
const machine = vi.hoisted(() => ({ credentials: new Map<string, string>(), settings: {} as Record<string, unknown>, directory: "" }));
// Resolve the package seam to its source so this test doesn't require a build.
vi.mock("@fezchat/protocol", async () => ({
  ...await import("../../../src/extensions/connections.js"),
  ...await import("../../fez-client/src/skill-attach.js"),
  ...await import("../../fez-client/src/skill-source.js"),
  personaPath: (name: string) => `${machine.directory}/${name}.md`,
}));
vi.mock("../../../src/shared/settings.js", () => ({
  loadSettings: () => machine.settings,
  saveSettings: (patch: object) => Object.assign(machine.settings, patch),
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: (file: string, args: string[]) => {
    if (file !== "security") throw new Error(`unexpected subprocess: ${file}`);
    const key = args[args.indexOf("-a") + 1];
    if (args[0] === "add-generic-password") {
      machine.credentials.set(key, args[args.indexOf("-w") + 1]);
      return "";
    }
    if (args[0] === "delete-generic-password") return machine.credentials.delete(key);
    const value = machine.credentials.get(key);
    if (!value) throw new Error("no credential");
    return value;
  },
}));

async function issuer() {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const state = { rejectExchange: false, exchanges: 0, refreshes: 0, registrations: 0, keepStream: false, activeStreams: 0, openedStreams: 0 };
  let base = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const json = (value: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: `${base}/mcp`, authorization_servers: [base] });
    } else if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"] });
    } else if (url.pathname === "/register") {
      let body = "";
      for await (const chunk of req) body += chunk;
      state.registrations++;
      json({ ...JSON.parse(body), client_id: randomUUID() }, 201);
    } else if (url.pathname === "/authorize") {
      const code = randomUUID();
      const redirect = url.searchParams.get("redirect_uri")!;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
      const target = new URL(redirect);
      target.searchParams.set("code", code);
      if (url.searchParams.has("state")) target.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { location: target.href }).end();
    } else if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes++;
        json({ access_token: "refreshed-access", token_type: "Bearer", expires_in: 3600 });
        return;
      }
      state.exchanges++;
      const code = codes.get(form.get("code")!);
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (state.rejectExchange || !code || challenge !== code.challenge || code.redirect !== form.get("redirect_uri")) {
        json({ error: "invalid_grant", error_description: "private-provider-detail" }, 400);
      } else {
        codes.delete(form.get("code")!);
        json({ access_token: "test-access", refresh_token: "test-refresh", token_type: "Bearer", expires_in: 3600 });
      }
    } else if (url.pathname === "/mcp") {
      if (!["Bearer test-access", "Bearer refreshed-access"].includes(req.headers.authorization ?? "")) {
        json({}, 401); return;
      }
      if (req.method === "GET" && state.keepStream) {
        state.activeStreams++;
        state.openedStreams++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": connected\n\n");
        res.on("close", () => { state.activeStreams--; });
        return;
      }
      const remote = new McpServer({ name: "test-service", version: "1" });
      remote.tool("read_issue", "Read an issue", { id: z.string() }, async ({ id }) => {
        if (state.keepStream) await new Promise((resolve) => setTimeout(resolve, 100));
        return { content: [{ type: "text", text: `Issue ${id}: Fix login` }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await remote.connect(transport);
      res.on("close", () => { void remote.close(); });
      let body = "";
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } else json({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  machine.settings = { mcpServers: { test: { type: "http", url: `${base}/mcp`, auth: "oauth" } } };
  return { base, state, close: () => { server.closeAllConnections(); server.close(); } };
}

let oauth: Awaited<ReturnType<typeof issuer>>;
// The mocked adapter models macOS Keychain even when CI runs on Linux.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeAll(() => Object.defineProperty(process, "platform", { value: "darwin" }));
afterAll(() => Object.defineProperty(process, "platform", platform));
beforeEach(async () => {
  machine.credentials.clear(); oauth = await issuer();
  CONNECTIONS.push({ key: "test", title: "Test Service", url: `${oauth.base}/mcp`, what: "issues" });
  machine.directory = fs.mkdtempSync(path.join(os.tmpdir(), "fez-oauth-"));
  fs.writeFileSync(path.join(machine.directory, "helper.md"), "---\nname: helper\nmcpServers: []\n---\nHelp with issues.\n");
});
afterEach(() => { CONNECTIONS.splice(CONNECTIONS.findIndex((entry) => entry.key === "test"), 1); oauth.close(); fs.rmSync(machine.directory, { recursive: true, force: true }); });

describe("interactive OAuth", () => {
  it("captures an immediate browser callback, verifies state and PKCE, and saves only after exchange", async () => {
    let browser: Promise<Response> | undefined;
    await connectService("test", { timeoutMs: 2000, onAuthUrl: async (url) => {
      const authorize = new URL(url);
      expect(authorize.searchParams.get("state")).toMatch(/^[a-zA-Z0-9_-]{32,}$/);
      expect(readConnection("test")).toBeUndefined();
      const wrong = new URL(authorize.searchParams.get("redirect_uri")!);
      wrong.searchParams.set("code", "injected");
      expect((await fetch(wrong)).status).toBe(400);
      wrong.searchParams.set("state", "wrong");
      expect((await fetch(wrong)).status).toBe(400);
      wrong.searchParams.set("state", authorize.searchParams.get("state")!);
      wrong.searchParams.append("state", "duplicate");
      expect((await fetch(wrong)).status).toBe(400);
      wrong.searchParams.set("state", authorize.searchParams.get("state")!);
      expect((await fetch(wrong, { method: "POST" })).status).toBe(404);
      wrong.pathname = "/callback-extra";
      expect((await fetch(wrong)).status).toBe(404);
      expect(oauth.state.exchanges).toBe(0);
      browser = fetch(url);
    } });
    expect((await browser!).status).toBe(200);
    expect(await (await browser!).text()).toContain("connected");
    expect(readConnection("test")?.tokens?.access_token).toBe("test-access");
    expect(oauth.state.exchanges).toBe(1);
  });

  it("a rejected exchange neither stores partial credentials nor tells the browser it connected", async () => {
    oauth.state.rejectExchange = true;
    let browser: Promise<Response> | undefined;
    await expect(connectService("test", { timeoutMs: 2000, onAuthUrl: (url) => { browser = fetch(url); } })).rejects.toThrow();
    const response = await browser!;
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-provider-detail");
    expect(readConnection("test")).toBeUndefined();
  });

  it("cancellation closes the callback and leaves no staged secrets", async () => {
    const controller = new AbortController();
    let callback = "";
    await expect(connectService("test", { signal: controller.signal, onAuthUrl: (url) => {
      callback = new URL(url).searchParams.get("redirect_uri")!;
      controller.abort();
    } })).rejects.toThrow();
    expect(readConnection("test")).toBeUndefined();
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("the deadline includes a stalled delivery of the owner link", async () => {
    let callback = "";
    await expect(connectService("test", { timeoutMs: 100, onAuthUrl: (url) => {
      callback = new URL(url).searchParams.get("redirect_uri")!;
      return new Promise<void>(() => {});
    } })).rejects.toThrow(/timed out/);
    expect(readConnection("test")).toBeUndefined();
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("cached sign-in registers the server, and completes attachment before showing success", async () => {
    let browser: Promise<Response> | undefined;
    await connectService("test", { onAuthUrl: (url) => { browser = fetch(url); }, onConnected: () => {
      expect(readConnection("test")?.tokens?.access_token).toBe("test-access");
    } });
    await browser;
    machine.settings = {};
    let completed = false;
    await connectService("test", { onAuthUrl: () => { throw new Error("must reuse the connection"); }, onConnected: () => { completed = true; } });
    expect(completed).toBe(true);
    expect(machine.settings).toMatchObject({ mcpServers: { test: { url: `${oauth.base}/mcp`, auth: "oauth", type: "http" } } });
    expect(oauth.state.exchanges).toBe(1);
  });

  it("attachment failure shows failure in the browser instead of a false success", async () => {
    let browser: Promise<Response> | undefined;
    await expect(connectService("test", { onAuthUrl: (url) => { browser = fetch(url); }, onConnected: () => {
      throw new Error("persona changed");
    } })).rejects.toThrow("persona changed");
    expect((await browser!).status).toBe(400);
  });

  it("denial does not overwrite an existing connection", async () => {
    let browser: Promise<Response> | undefined;
    await connectService("test", { onAuthUrl: (url) => { browser = fetch(url); } });
    await browser;
    const original = machine.credentials.get("test.OAUTH");
    await expect(connectService("test", { forceAuthorization: true, onAuthUrl: (url) => {
      const authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      callback.searchParams.set("error", "access_denied");
      browser = fetch(callback);
    } })).rejects.toThrow(/declined/);
    expect((await browser!).status).toBe(400);
    expect(machine.credentials.get("test.OAUTH")).toBe(original);
  });

  it("new agent consent does not reuse an existing token; refresh later keeps the refresh token", async () => {
    const signIn = async () => {
      let browser: Promise<Response> | undefined;
      await connectService("test", { forceAuthorization: true, onAuthUrl: (url) => { browser = fetch(url); } });
      await browser;
    };
    await signIn();
    await signIn();
    expect(oauth.state.exchanges).toBe(2);
    const blob = readConnection("test")!;
    machine.credentials.set("test.OAUTH", JSON.stringify({ ...blob, savedAt: 1 }));
    expect(await freshToken("test")).toBe("refreshed-access");
    expect(readConnection("test")?.tokens?.refresh_token).toBe("test-refresh");
  });
});

async function agentSession(owner: string | undefined = "a".repeat(64)) {
  const privateMessages: string[] = [];
  const server = new McpServer({ name: "fez-test", version: "1" });
  registerConnectionTools(server, { persona: "helper", owner, sendOwner: async (message) => { privateMessages.push(message); } });
  const client = new Client({ name: "agent", version: "1" });
  const [agent, host] = InMemoryTransport.createLinkedPair();
  await server.connect(host);
  await client.connect(agent);
  return { client, privateMessages, close: async () => { await client.close(); await server.close(); } };
}

describe("connect from the running agent", () => {
  it("privately obtains consent, persists attachment and resumes the original task in the same MCP session", async () => {
    const session = await agentSession();
    try {
      const denied = await session.client.callTool({ name: "fez_service_tools", arguments: { service: "test" } });
      expect(denied.isError).toBe(true);
      const started = await session.client.callTool({ name: "fez_connect_service", arguments: { service: "test" } });
      expect(JSON.stringify(started)).toContain("pending");
      expect(JSON.stringify(started)).not.toContain("/authorize");
      await vi.waitFor(() => expect(session.privateMessages).toHaveLength(1));
      expect(session.privateMessages[0]).toContain("@helper");
      expect(fs.readFileSync(path.join(machine.directory, "helper.md"), "utf8")).toContain("mcpServers: []");
      const link = session.privateMessages[0].match(/https?:\/\/[^\s)]+/)![0];
      const browser = await fetch(link);
      expect(browser.status).toBe(200);
      const finished = await session.client.callTool({ name: "fez_connect_service", arguments: { service: "test", action: "wait" } });
      expect(JSON.stringify(finished)).toContain("connected");
      expect(fs.readFileSync(path.join(machine.directory, "helper.md"), "utf8")).toContain(`mcpServers: [test=${oauth.base}/mcp]`);
      const tools = await session.client.callTool({ name: "fez_service_tools", arguments: { service: "test" } });
      expect(JSON.stringify(tools)).toContain("read_issue");
      const result = await session.client.callTool({ name: "fez_service_call", arguments: { service: "test", tool: "read_issue", arguments: { id: "FEZ-42" } } });
      expect(JSON.stringify(result)).toContain("Issue FEZ-42: Fix login");
      expect(JSON.stringify([started, finished, tools, result])).not.toMatch(/test-access|test-refresh|code_verifier/);
      const resumed = await agentSession();
      try {
        const persisted = await resumed.client.callTool({ name: "fez_service_tools", arguments: { service: "test" } });
        expect(JSON.stringify(persisted)).toContain("read_issue");
        expect(resumed.privateMessages).toHaveLength(0);
      } finally { await resumed.close(); }
      await session.client.callTool({ name: "fez_connect_service", arguments: { service: "test", action: "reconnect" } });
      await vi.waitFor(() => expect(session.privateMessages).toHaveLength(2));
      await session.client.callTool({ name: "fez_connect_service", arguments: { service: "test", action: "cancel" } });
      // Removing the attachment immediately withdraws proxy access, even with
      // working machine credentials and a previously connected MCP session.
      fs.writeFileSync(path.join(machine.directory, "helper.md"), "---\nname: helper\nmcpServers: []\n---\n");
      const detached = await session.client.callTool({ name: "fez_service_call", arguments: { service: "test", tool: "read_issue", arguments: { id: "FEZ-42" } } });
      expect(detached.isError).toBe(true);
    } finally { await session.close(); }
  });

  it("deduplicates pending consent and cancellation never attaches the service", async () => {
    const session = await agentSession();
    try {
      const start = () => session.client.callTool({ name: "fez_connect_service", arguments: { service: "test" } });
      await start(); await start();
      await vi.waitFor(() => expect(session.privateMessages).toHaveLength(1));
      await session.client.callTool({ name: "fez_connect_service", arguments: { service: "test", action: "cancel" } });
      expect(fs.readFileSync(path.join(machine.directory, "helper.md"), "utf8")).toContain("mcpServers: []");
      expect(readConnection("test")).toBeUndefined();
    } finally { await session.close(); }
  });

  it("session shutdown cancels an outstanding callback", async () => {
    const session = await agentSession();
    await session.client.callTool({ name: "fez_connect_service", arguments: { service: "test" } });
    await vi.waitFor(() => expect(session.privateMessages).toHaveLength(1));
    const link = new URL(session.privateMessages[0].match(/https?:\/\/[^\s)]+/)![0]);
    await session.close();
    await vi.waitFor(async () => { await expect(fetch(link.searchParams.get("redirect_uri")!)).rejects.toThrow(); });
    expect(readConnection("test")).toBeUndefined();
  });

  it("machine credentials alone cannot grant a new agent access", async () => {
    let browser: Promise<Response> | undefined;
    await connectService("test", { onAuthUrl: (url) => { browser = fetch(url); } });
    await browser;
    const session = await agentSession();
    try {
      await session.client.callTool({ name: "fez_connect_service", arguments: { service: "test" } });
      await vi.waitFor(() => expect(session.privateMessages).toHaveLength(1));
      const result = await session.client.callTool({ name: "fez_service_tools", arguments: { service: "test" } });
      expect(result.isError).toBe(true);
      expect(fs.readFileSync(path.join(machine.directory, "helper.md"), "utf8")).toContain("mcpServers: []");
    } finally { await session.close(); }
  });

  it("closes a service's background event stream when a proxy call finishes", async () => {
    let browser: Promise<Response> | undefined;
    await connectService("test", { onAuthUrl: (url) => { browser = fetch(url); } });
    await browser;
    fs.writeFileSync(path.join(machine.directory, "helper.md"), "---\nname: helper\nmcpServers: [test]\n---\n");
    oauth.state.keepStream = true;
    const session = await agentSession();
    try {
      const result = await session.client.callTool({ name: "fez_service_call", arguments: { service: "test", tool: "read_issue", arguments: { id: "FEZ-42" } } });
      expect(result.isError).not.toBe(true);
      expect(oauth.state.openedStreams).toBeGreaterThan(0);
      await vi.waitFor(() => expect(oauth.state.activeStreams).toBe(0));
    } finally { await session.close(); }
  });

  it("refuses connection without a configured owner and exposes no persona or recipient override", async () => {
    const session = await agentSession("");
    try {
      const result = await session.client.callTool({ name: "fez_connect_service", arguments: { service: "test" } });
      expect(result.isError).toBe(true);
      expect(session.privateMessages).toHaveLength(0);
      const tools = await session.client.listTools();
      const schema = tools.tools.find((t) => t.name === "fez_connect_service")!.inputSchema;
      expect(schema.properties).not.toHaveProperty("owner");
      expect(schema.properties).not.toHaveProperty("persona");
    } finally { await session.close(); }
  });
});
