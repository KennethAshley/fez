import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection } from "../../../src/protocol/relay.js";
import { buildNip98Header } from "../../../src/protocol/nip98.js";
import { KIND_MEMBERSHIP, ROSTER_D } from "../../../src/protocol/kinds.js";
import { startRelay, type RelayHandle } from "../../../packages/fez-relay/src/relay.js";
import { listenLocal, startMeshHost, startMeshGateway, workspaceAccess } from "./mesh.js";

const { values } = parseArgs({ options: { upstream: { type: "string" }, model: { type: "string" }, pi: { type: "string" } } });
if (!!values.upstream !== !!values.model) throw new Error("Supply both --upstream and --model, or neither for the simulated model");
const model = values.model || "mesh-fixture";
const prompt = "Reply exactly: LOCAL_MESH_OK";
const cleanup: (() => void | Promise<void>)[] = [];

async function main() {
  console.log(values.upstream ? `Real model endpoint: ${values.upstream} (${model})` : "SIMULATED MODEL: testing the transport and pi integration, not model inference.");
  console.log("All listeners are loopback-only; all identities and configuration are temporary.");
  let upstream = values.upstream;
  if (!upstream) {
    const fixture = await listenLocal(createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const request = JSON.parse(text);
      const base = { id: "chatcmpl-mesh-fixture", created: Math.floor(Date.now() / 1000), model };
      if (request.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "LOCAL_MESH_OK" }, finish_reason: null }] },
          { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
        ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.setHeader("content-type", "application/json").end(JSON.stringify({ ...base, object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "LOCAL_MESH_OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
      }
    }));
    cleanup.push(fixture.close);
    upstream = fixture.url + "/v1";
  }
  const owner = generateSecretKey(), agent = generateSecretKey(), stranger = generateSecretKey();
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
  const roster = (admitted: boolean) => wire.publish(finalizeEvent({ kind: KIND_MEMBERSHIP, created_at: timestamp++, content: "",
    tags: [["d", ROSTER_D], ...(admitted ? [["p", getPublicKey(agent), "bot"]] : [])] }, owner));
  await roster(true);
  const host = await startMeshHost({ upstream, model, isMember: workspaceAccess(wire, getPublicKey(owner)) });
  cleanup.push(host.close);
  const token = randomUUID();
  const gateway = await startMeshGateway({ host: host.url, secretKey: agent, token });
  cleanup.push(gateway.close);
  const body = JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 32 });
  const request = () => fetch(gateway.url + "/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body,
  });
  const response = await request();
  assert.equal(response.status, 200, await response.clone().text());
  console.log("PASS: rostered agent received a response through the signed model gateway.");
  const reply = await response.json() as { choices?: { message?: { content?: unknown } }[] };
  console.log("Model response:", reply.choices?.[0]?.message?.content);

  const pi = values.pi || join(homedir(), ".fez", "bin", "pi");
  if (existsSync(pi)) {
    const configDir = await mkdtemp(join(tmpdir(), "fez-mesh-pi-"));
    cleanup.push(() => rm(configDir, { recursive: true, force: true }));
    await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { "fez-mesh": {
      baseUrl: gateway.url + "/v1", api: "openai-completions", apiKey: token,
      // pi reserves 4096 context tokens; a 4096 window clamps every reply to one token.
      models: [{ id: model, name: model, reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }), { mode: 0o600 });
    await writeFile(join(configDir, "settings.json"), '{"quietStartup":true}', { mode: 0o600 });
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(pi, ["--offline", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--provider", "fez-mesh", "--model", model,
      "--thinking", "off", "--system-prompt", "You are testing a shared local model. Answer briefly.", "-p", prompt], {
      cwd: configDir, timeout: 90000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        PI_CODING_AGENT_DIR: configDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      }, (error, stdout, stderr) => error ? reject(new Error(`pi failed: ${stderr || error.message}`)) : resolve(stdout));
      // pi reads redirected stdin before running the prompt; an open pipe waits forever.
      child.stdin?.end();
    });
    assert.ok(stdout.trim(), "pi returned no output");
    console.log("PASS: bundled pi used the mesh provider:", stdout.trim());
  } else console.log("SKIP: pi not found; pass --pi /absolute/path/to/pi to verify the agent harness.");

  const url = host.url + "/v1/chat/completions";
  const denied = await fetch(url, { method: "POST", body, headers: {
    Authorization: buildNip98Header(stranger, url, "POST", Buffer.from(body)),
  } });
  assert.equal(denied.status, 403);
  console.log("PASS: a stranger cannot use the shared model.");
  await roster(false);
  assert.equal((await request()).status, 403);
  console.log("PASS: removing the agent from the roster blocks its next request.");
  assert.ok(!JSON.stringify(relay.query({})).includes(prompt));
  console.log("PASS: the relay contains membership events, not model prompts.");
}

try { await main(); }
finally { for (const close of cleanup.reverse()) await close(); }
