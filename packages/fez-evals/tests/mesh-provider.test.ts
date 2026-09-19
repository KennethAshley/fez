import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { buildNip98Header } from "../../../src/protocol/nip98.js";
import { listenLocal } from "../../fez-mesh/src/mesh.js";
import { startProvider, updateMember, checkProvider } from "../../fez-mesh/src/provider.js";
import { configureClient, sshArguments, type GatewayConfig } from "../../fez-mesh/src/config.js";
import { activateModelProfile } from "../../fez-acp/src/model-profile.js";

const config: GatewayConfig = { role: "gateway", ssh: "ken@kenmini.local", remoteNode: "/usr/local/bin/node",
  remoteCli: "/Users/ken/.fez/mesh/mini/cli.mjs", remoteConfig: "/Users/ken/.fez/mesh/mini/config.json",
  hostPort: 18090, relayPort: 18092, port: 18091, persona: "mini-mesh", model: "qwen3-4b",
  contextWindow: 16384, maxTokens: 1024, token: "a-test-token-with-at-least-32-characters",
  owner: "a".repeat(64), ownerKey: "agent:mesh-mini-owner" };

const pi = join(homedir(), ".fez/bin/pi");
it.skipIf(!existsSync(pi))("uses the isolated Mini profile and sends an uncertain inference only once", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-retry-test-"));
  let calls = 0;
  const upstream = await listenLocal(createServer((_req, res) => {
    calls++; res.writeHead(503, { "content-type": "application/json" }).end('{"error":{"message":"synthetic model failure"}}');
  }));
  try {
    await configureClient({ ...config, port: Number(new URL(upstream.url).port) }, home);
    const running = promisify(execFile)(pi, ["--offline", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
      "--no-context-files", "--no-prompt-templates", "--no-themes", "-p", "Reply OK"], {
      cwd: home, timeout: 5000, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, ".fez/model-profiles/fez-mesh-mini/mini-mesh") },
    });
    running.child.stdin?.end();
    await running.catch(() => {});
    expect(calls).toBe(1);
  } finally { await upstream.close(); await rm(home, { recursive: true, force: true }); }
}, 10000);

it("writes the pilot as a private model profile and leaves pi's global registry alone", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-config-test-"));
  const globalFile = join(home, ".pi/agent/models.json");
  const profileDir = join(home, ".fez/model-profiles/fez-mesh-mini/mini-mesh");
  try {
    await mkdir(join(home, ".pi/agent"), { recursive: true });
    const untouched = JSON.stringify({ metadata: "keep", providers: { existing: { apiKey: "keep-private" } } });
    await writeFile(globalFile, untouched);
    await configureClient(config, home);
    await configureClient(config, home);
    // The global registry is exactly what it was: the pilot must never fall through to it.
    expect(await readFile(globalFile, "utf8")).toBe(untouched);
    expect(existsSync(join(home, ".fez/mesh/mini/pi"))).toBe(false);
    const persona = await readFile(join(home, ".fez/personas/mini-mesh.md"), "utf8");
    expect(persona).toContain("provider: fez-mesh-mini");
    expect(persona).toContain("modelProfile: fez-mesh-mini");
    const models = JSON.parse(await readFile(join(profileDir, "models.json"), "utf8"));
    expect(Object.keys(models.providers)).toEqual(["fez-mesh-mini"]);
    expect(models.providers["fez-mesh-mini"].baseUrl).toBe("http://127.0.0.1:18091/v1");
    expect(JSON.parse(await readFile(join(profileDir, "settings.json"), "utf8")).retry).toEqual({ enabled: false });
    for (const file of ["profile.json", "models.json", "settings.json"]) expect((await stat(join(profileDir, file))).mode & 0o777).toBe(0o600);
    // The layout is the one fez-acp gates on at agent start.
    const env: NodeJS.ProcessEnv = {};
    expect(activateModelProfile({ id: "mini-mesh", harness: "pi", extra: { modelProfile: "fez-mesh-mini", provider: "fez-mesh-mini", model: config.model } }, home, env)).toBe(true);
    expect(env.FEZ_PI_REQUIRED_MODEL).toBe(`fez-mesh-mini/${config.model}`);
    expect(env.PI_CODING_AGENT_DIR).toBe(profileDir);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("upgrades a pilot persona written before modelProfile, but never rewrites a customised one", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-upgrade-test-"));
  const persona = join(home, ".fez/personas/mini-mesh.md");
  try {
    await configureClient(config, home);
    const current = await readFile(persona, "utf8");
    await writeFile(persona, current.replace("modelProfile: fez-mesh-mini\n", ""));
    await configureClient(config, home);
    expect(await readFile(persona, "utf8")).toBe(current);
    await writeFile(persona, current + "\nAlways answer in French.\n");
    await expect(configureClient(config, home)).rejects.toThrow(/left untouched/);
    expect(await readFile(persona, "utf8")).toBe(current + "\nAlways answer in French.\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("pins SSH host keys and rejects option or shell injection in the saved transport", () => {
  const args = sshArguments(config);
  expect(args).toContain("StrictHostKeyChecking=yes");
  expect(args).toContain("BatchMode=yes");
  expect(args).toContain("ExitOnForwardFailure=yes");
  for (const invalid of [{ ssh: "-oProxyCommand=touch /tmp/pwn" }, { remoteCli: "/tmp/cli; touch /tmp/pwn" }]) {
    expect(() => sshArguments({ ...config, ...invalid })).toThrow();
  }
});

it("preserves provider membership and revocation across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mesh-provider-test-"));
  const upstream = await listenLocal(createServer((_req, res) => res.end('{"data":[{"id":"test"}]}')));
  const owner = generateSecretKey(), agent = generateSecretKey();
  const options = { upstream: upstream.url + "/v1", model: "test", owner: getPublicKey(owner),
    store: join(directory, "relay.jsonl"), port: 0, relayPort: 0, maxTokens: 32 };
  let provider = await startProvider(options);
  const request = async () => {
    const url = provider.url + "/v1/models";
    return fetch(url, { headers: { Authorization: buildNip98Header(agent, url, "GET") } });
  };
  try {
    expect((await request()).status).toBe(503); // No roster never admits a member.
    await updateMember(provider.wire, owner, getPublicKey(agent), true);
    expect((await request()).status).toBe(200);
    const listening = { ...options, port: Number(new URL(provider.url).port), relayPort: Number(new URL(provider.wire.urls[0]).port) };
    await checkProvider(listening);
    await provider.close();
    await expect(checkProvider(listening)).rejects.toThrow(); // The model alone cannot establish provider readiness.
    provider = await startProvider(options);
    expect((await request()).status).toBe(200);
    await updateMember(provider.wire, owner, getPublicKey(agent), false);
    expect((await request()).status).toBe(403);
    await provider.close();
    provider = await startProvider(options);
    expect((await request()).status).toBe(403);
  } finally {
    await provider.close(); await upstream.close();
    await rm(directory, { recursive: true, force: true });
  }
});
