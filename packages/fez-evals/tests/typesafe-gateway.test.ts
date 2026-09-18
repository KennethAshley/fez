import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { agentTool, noneTool, routerBody } from "../../fez-orchestrator/src/route-logic.js";

let dir: string, child: ChildProcess, url: string;
let provider: http.Server, upstream: http.Server;
let mode = "ok", providerCalls = 0, upstreamCalls = 0;
let received: unknown, receivedLocal: unknown;
const payload = { model: "fez-router", messages: [{ role: "user", content: "find the spec" }],
  tools: ["researcher", "reviewer", "nobody"].map(name => ({ type: "function", function: {
    name, description: name, parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  } })) };

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}
const json = (res: http.ServerResponse, body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fez-typesafe-gateway-"));
  provider = http.createServer(async (req, res) => {
    providerCalls++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    if (mode === "timeout") return;
    if (mode === "error") { res.statusCode = 503; return json(res, { error: "provider error" }); }
    const choice = mode === "none" ? "nobody" : "researcher";
    json(res, { model: "jev-1.13.0", answers: { route: { type: "choice", choice: mode === "invalid" ? "stranger" : choice,
      confidence: 0.8, probabilities: { researcher: choice === "researcher" ? 0.9 : 0.05, reviewer: 0.05, nobody: choice === "nobody" ? 0.9 : 0.05 } } },
      usage: { input_tokens: 150, output_tokens: 20 } });
  });
  upstream = http.createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) return json(res, { data: [{ id: "fez-router" }] });
    upstreamCalls++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    receivedLocal = JSON.parse(Buffer.concat(chunks).toString());
    json(res, { model: "local-fallback", choices: [{ message: { tool_calls: [{ function: { name: "reviewer", arguments: "{}" } }] } }] });
  });
  const providerUrl = await listen(provider), upstreamUrl = await listen(upstream);
  const bundle = await build({ entryPoints: [path.resolve("../../deploy/router/gateway.mjs")], bundle: true,
    platform: "node", format: "esm", write: false });
  const gateway = path.join(dir, "gateway.mjs"), preload = path.join(dir, "preload.mjs");
  await writeFile(gateway, bundle.outputFiles[0].text);
  await writeFile(preload, `const original = globalThis.fetch; globalThis.fetch = (url, opts) => original(String(url) === 'https://api.typesafe.ai/v1/systemone' ? ${JSON.stringify(providerUrl)} : url, opts);`);
  child = spawn(process.execPath, ["--import", preload, gateway], { env: { ...process.env,
    PORT: "0", UPSTREAM: upstreamUrl, ROUTER_API_KEY: "gateway-test-key", TYPESAFE_API_KEY: "provider-test-key",
    TYPESAFE_TIMEOUT_MS: "100", RATE_PER_MIN: "100", RATE_BURST: "2" }, stdio: ["ignore", "pipe", "pipe"] });
  url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("gateway did not start")), 5000);
    child.stdout!.on("data", chunk => {
      output += chunk.toString();
      const m = output.match(/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("gateway exited during startup")); });
  });
}, 10000);

afterAll(async () => {
  child?.kill(); if (child && child.exitCode === null) await once(child, "exit");
  for (const server of [provider, upstream]) { server?.closeAllConnections(); server?.close(); }
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function route(authorized = true, body: unknown = payload) {
  return fetch(`${url}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json", ...(authorized ? { Authorization: "Bearer gateway-test-key" } : {}) },
    body: JSON.stringify(body) });
}

describe("hosted TypeSafe routing with local fallback", () => {
  it("requires the gateway credential before making a paid call", async () => {
    const before = providerCalls;
    expect((await route(false)).status).toBe(401);
    expect(providerCalls).toBe(before);
  });

  it("returns a compatible tool call through the shared TypeSafe judgment", async () => {
    const before = upstreamCalls;
    const res = await route(); const body = await res.json();
    expect(res.headers.get("x-fez-router-backend")).toBe("typesafe");
    expect(body.choices[0].message.tool_calls[0].function).toEqual({ name: "researcher", arguments: '{"task":"find the spec"}' });
    expect(body.usage).toEqual({ prompt_tokens: 150, completion_tokens: 20, total_tokens: 170 });
    expect(received).toMatchObject({ model: "jev-1.13.0", state: { message: "find the spec" } });
    expect(upstreamCalls).toBe(before);
  });

  it("keeps a legitimate no-fit result instead of asking the fallback to override it", async () => {
    mode = "none"; const before = upstreamCalls;
    const body = await (await route()).json();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("nobody");
    expect(upstreamCalls).toBe(before); mode = "ok";
  });

  it.each(["minimal", "tools"] as const)("accepts the real orchestrator %s request shape", async profile => {
    const res = await route(true, routerBody(profile, "fez-router", "find the spec",
      [agentTool({ name: "researcher" }), agentTool({ name: "reviewer" }), noneTool()]));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-fez-router-backend")).toBe("typesafe");
  });

  it.each([
    { ...payload, messages: [{ role: "system", content: "custom routing rules" }, ...payload.messages] },
    { ...payload, tools: payload.tools.map(t => ({ ...t, function: { ...t.function,
      parameters: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] } } })) },
    { ...payload, tools: payload.tools.map(t => ({ ...t, function: { ...t.function,
      parameters: { type: "object", additionalProperties: { type: "string" } } } })) },
  ])("preserves unsupported instructions and arguments for the local model", async request => {
    const before = providerCalls;
    const res = await route(true, request);
    expect(res.headers.get("x-fez-router-backend")).toBe("local");
    expect(receivedLocal).toMatchObject(request);
    expect(providerCalls).toBe(before);
  });

  it.each([null, [], { ...payload, stream: true }])("rejects invalid bodies and streaming before inference", async request => {
    const before = [providerCalls, upstreamCalls];
    expect((await route(true, request)).status).toBe(400);
    expect([providerCalls, upstreamCalls]).toEqual(before);
  });

  it.each(["error", "invalid", "timeout"])("uses the existing local router on TypeSafe %s", async problem => {
    mode = problem; const before = upstreamCalls;
    const res = await route(); const body = await res.json();
    expect(res.headers.get("x-fez-router-backend")).toBe("local");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("reviewer");
    expect(upstreamCalls).toBe(before + 1); mode = "ok";
  });
});
