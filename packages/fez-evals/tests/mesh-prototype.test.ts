import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { buildNip98Header } from "../../../src/protocol/nip98.js";
import { RelayConnection } from "../../../src/protocol/relay.js";
import { KIND_BAN_LIST, KIND_MEMBERSHIP, ROSTER_D, BANS_D } from "../../../src/protocol/kinds.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";
import { listenLocal, startMeshHost, startMeshGateway, workspaceAccess } from "../../../dev/experiments/mesh/mesh.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const owner = generateSecretKey(), member = generateSecretKey(), stranger = generateSecretKey();
  let relay!: RelayHandle;
  const relayUrl = await new Promise<string>(resolve => {
    relay = startRelay({ port: 0, host: "127.0.0.1", workspace: { owner: getPublicKey(owner) }, log: () => {},
      onListening: port => resolve(`ws://127.0.0.1:${port}`) });
  });
  cleanup.push(() => relay.close());
  const wire = new RelayConnection({ url: relayUrl });
  cleanup.push(() => wire.disconnect());
  await wire.connect();
  let timestamp = Math.floor(Date.now() / 1000) - 10;
  async function roster(keys: Uint8Array[], signer = owner) {
    await wire.publish(finalizeEvent({ kind: KIND_MEMBERSHIP, created_at: timestamp++, content: "",
      tags: [["d", ROSTER_D], ...keys.map(key => ["p", getPublicKey(key), "bot"])] }, signer));
  }
  await roster([member]);
  const received: { authorization?: string; body: string }[] = [];
  let upstreamStatus = 200;
  const upstream = await listenLocal(createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ authorization: req.headers.authorization, body });
    if (upstreamStatus !== 200) { res.writeHead(upstreamStatus, { location: "http://127.0.0.1:1/leak" }).end("private upstream diagnostic"); return; }
    if (JSON.parse(body).stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "chatcmpl-test", model: "shared-model", created: 1, object: "chat.completion.chunk" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else res.setHeader("content-type", "application/json").end('{"choices":[{"message":{"content":"hello"}}]}');
  }));
  cleanup.push(upstream.close);
  const host = await startMeshHost({ upstream: upstream.url + "/v1", model: "shared-model",
    isMember: workspaceAccess(wire, getPublicKey(owner)), timeoutMs: 1000 });
  cleanup.push(host.close);
  const gateway = await startMeshGateway({ host: host.url, secretKey: member, token: "test-local-token" });
  cleanup.push(gateway.close);
  const body = JSON.stringify({ model: "shared-model", messages: [{ role: "user", content: "private mesh prompt" }] });
  const url = host.url + "/v1/chat/completions";
  const direct = (key: Uint8Array, data = body, signedBody = data, signedUrl = url) => fetch(url, {
    method: "POST", headers: { Authorization: buildNip98Header(key, signedUrl, "POST", Buffer.from(signedBody)) }, body: data,
  });
  return { owner, member, stranger, wire, relay, roster, received, host, gateway, body, url, direct, upstream: upstream.url + "/v1",
    setStatus: (status: number) => { upstreamStatus = status; },
    chat: (stream = false, token = "test-local-token") => fetch(gateway.url + "/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: stream ? JSON.stringify({ ...JSON.parse(body), stream }) : body,
    }),
    ban: () => wire.publish(finalizeEvent({ kind: KIND_BAN_LIST, created_at: timestamp++, content: "",
      tags: [["d", BANS_D], ["p", getPublicKey(member)]] }, owner)),
  };
}

it("carries ordinary and streaming model calls through a member gateway without publishing prompts", async () => {
  const f = await setup();
  const result = await f.chat();
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ choices: [{ message: { content: "hello" } }] });
  // Identical requests within the same second must still get unique signed credentials.
  expect((await f.chat()).status).toBe(200);
  const stream = await f.chat(true);
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  const chunks = await stream.text();
  expect(chunks).toContain('"content":"hello"');
  expect(chunks).toContain('"finish_reason":"stop"');
  expect(chunks.endsWith("data: [DONE]\n\n")).toBe(true);
  expect(f.received).toHaveLength(3);
  expect(f.received.every(request => request.authorization === undefined)).toBe(true);
  expect(f.received[0].body).toBe(f.body);
  expect(JSON.stringify(f.relay.query({}))).not.toContain("private mesh prompt");
});

it("blocks strangers, local callers without the token, and roster removal", async () => {
  const f = await setup();
  expect((await f.direct(f.stranger)).status).toBe(403);
  expect((await f.chat(false, "wrong")).status).toBe(401);
  expect((await fetch(f.host.url + "/v1/models")).status).toBe(401);
  const models = await fetch(f.gateway.url + "/v1/models", { headers: { Authorization: "Bearer test-local-token" } });
  expect(await models.json()).toMatchObject({ data: [{ id: "shared-model" }] });
  await f.roster([f.stranger], f.stranger); // A self-signed roster grants nothing.
  expect((await f.direct(f.stranger)).status).toBe(403);
  await f.roster([]);
  expect((await f.chat()).status).toBe(403);
  expect(f.received).toHaveLength(0);
});

it("honors bans and fails closed when fresh membership cannot be obtained", async () => {
  const f = await setup();
  await f.ban();
  expect((await f.chat()).status).toBe(403);
  f.wire.disconnect();
  expect((await f.chat()).status).toBe(503);
  expect(f.received).toHaveLength(0);
});

it("requires the signed request body and origin, rejects replays and malformed credentials", async () => {
  const f = await setup();
  const headers = { Authorization: buildNip98Header(f.member, f.url, "POST", Buffer.from(f.body)) };
  expect((await fetch(f.url, { method: "POST", headers, body: f.body })).status).toBe(200);
  expect((await fetch(f.url, { method: "POST", headers, body: f.body })).status).toBe(401);
  expect((await f.direct(f.member, f.body, "different body")).status).toBe(401);
  expect((await f.direct(f.member, f.body, f.body, "http://127.0.0.1:1/v1/chat/completions")).status).toBe(401);
  for (const authorization of [buildNip98Header(f.member, f.url, "POST"), "Nostr " + Buffer.from("null").toString("base64")]) {
    expect((await fetch(f.url, { method: "POST", headers: { Authorization: authorization }, body: f.body })).status).toBe(401);
  }
  const signed = JSON.parse(Buffer.from(headers.Authorization.slice(6), "base64").toString());
  for (const payload of [["payload"], ["payload", ""]]) {
    const event = finalizeEvent({ ...signed, tags: [...signed.tags.filter((tag: string[]) => tag[0] !== "payload"), payload] }, f.member);
    const authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
    expect((await fetch(f.url, { method: "POST", headers: { Authorization: authorization }, body: f.body })).status).toBe(401);
  }
  expect(f.received).toHaveLength(1);
});

it("rejects unshared models and large payloads, and does not follow upstream redirects", async () => {
  const f = await setup();
  expect((await f.direct(f.member, '{"model":"other","messages":[]}')).status).toBe(400);
  expect((await f.direct(f.member, "x".repeat(262145))).status).toBe(413);
  expect(f.received).toHaveLength(0);
  f.setStatus(302);
  const result = await f.chat();
  expect(result.status).toBe(502);
  expect(await result.text()).not.toContain("private upstream diagnostic");
});

it("keeps this prototype on loopback and refuses URL credentials", async () => {
  for (const upstream of ["http://example.com/v1", "http://0.0.0.0/v1", "http://user:pass@127.0.0.1/v1", "http://127.0.0.1/v1?key=secret"]) {
    await expect(startMeshHost({ upstream, model: "shared-model", isMember: async () => true })).rejects.toThrow(/loopback|credentials|query/i);
  }
});

const bundledPi = join(homedir(), ".fez", "bin", "pi");
it("keeps a saved provider address and caps model output at the serving boundary", async () => {
  const f = await setup();
  const vacant = await listenLocal(createServer());
  const port = Number(new URL(vacant.url).port);
  await vacant.close();
  const host = await startMeshHost({ upstream: f.upstream, model: "shared-model", isMember: async () => true, port, maxTokens: 16 });
  cleanup.push(host.close);
  expect(host.url).toBe(`http://127.0.0.1:${port}`);
  const url = host.url + "/v1/chat/completions";
  const body = JSON.stringify({ model: "shared-model", messages: [], max_completion_tokens: 10000 });
  const response = await fetch(url, { method: "POST", body, headers: {
    Authorization: buildNip98Header(f.member, url, "POST", Buffer.from(body)),
  } });
  expect(response.status).toBe(200);
  expect(JSON.parse(f.received[0].body).max_completion_tokens).toBe(16);
});

it("refuses overlapping inference instead of building an unbounded GPU queue", async () => {
  let entered!: () => void, release!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const upstream = await listenLocal(createServer(async (_req, res) => { entered(); await finish; res.end("{}"); }));
  cleanup.push(upstream.close);
  const host = await startMeshHost({ upstream: upstream.url, model: "test", isMember: async () => true });
  cleanup.push(host.close);
  const key = generateSecretKey(), url = host.url + "/v1/chat/completions";
  const request = (text: string, signal?: AbortSignal) => {
    const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: text }] });
    return fetch(url, { method: "POST", body, signal, headers: { Authorization: buildNip98Header(key, url, "POST", Buffer.from(body)) } });
  };
  const first = request("first");
  try {
    await firstEntered;
    const second = await request("second", AbortSignal.timeout(250)).catch(() => ({ status: 0 }));
    expect(second.status).toBe(429);
  } finally { release(); await first; }
});

it.skipIf(!existsSync(bundledPi))("gives the real pi harness enough output tokens after its context safety reserve", async () => {
  const f = await setup();
  const script = fileURLToPath(new URL("../../../dev/experiments/mesh/run.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, "--upstream", f.upstream, "--model", "shared-model", "--pi", bundledPi], {
    timeout: 15000, maxBuffer: 1024 * 1024,
  });
  expect(stdout).toContain("PASS: bundled pi used the mesh provider: hello");
  const request = f.received.map(row => JSON.parse(row.body)).find(row => row.stream);
  expect(request).toBeDefined();
  expect(request.max_completion_tokens ?? request.max_tokens).toBeGreaterThanOrEqual(8);
  expect(request.max_completion_tokens ?? request.max_tokens).toBeLessThanOrEqual(128);
}, 20000);
