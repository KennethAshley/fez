import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { listenLocal, startMeshGateway, gatewayReady, workspaceAccess } from "../../fez-mesh/src/mesh.js";
import { startProvider, updateMember } from "../../fez-mesh/src/provider.js";
import { enrollCaller, revokeCaller, resolveCallerToken, listCallers, publicCallers, validatePersona, withCallerLock, MODEL_PROVIDER } from "../../fez-mesh/src/enrollment.js";
import type { GatewayConfig } from "../../fez-mesh/src/config.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("enrolls two isolated signers and revokes only the selected caller", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-callers-")); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const owner = generateSecretKey(), alex = generateSecretKey(), blair = generateSecretKey(), pilot = generateSecretKey();
  const keys = new Map([["agent:alex", Buffer.from(alex).toString("hex")], ["agent:blair", Buffer.from(blair).toString("hex")], ["agent:pilot", Buffer.from(pilot).toString("hex")]]);
  const loadKey = (name: string) => { const key = keys.get(name); if (!key) throw new Error("missing key"); return key; };
  const upstream = await listenLocal(createServer((_req, res) => res.end('{"choices":[]}'))); cleanup.push(upstream.close);
  const provider = await startProvider({ upstream: upstream.url, model: "test", owner: getPublicKey(owner), store: join(home, "relay.jsonl"), port: 0, relayPort: 0, maxTokens: 32 }); cleanup.push(provider.close);
  const config: GatewayConfig = { role: "gateway", ssh: "test@mini.local", remoteNode: "/usr/bin/node", remoteCli: "/tmp/cli.mjs", remoteConfig: "/tmp/config.json", hostPort: 18090, relayPort: 18091, port: 18092, persona: "pilot", model: "test", contextWindow: 8192, maxTokens: 32, token: "pilot-token-abcdefghijklmnopqrstuvwxyz", owner: getPublicKey(owner), ownerKey: "agent:owner" };
  const membership = (pubkey: string, admit: boolean) => updateMember(provider.wire, owner, pubkey, admit);
  await membership(getPublicKey(pilot), true);
  const currentMember = workspaceAccess(provider.wire, config.owner);
  expect(await publicCallers({ home, legacyPersona: config.persona, loadKey, isMember: currentMember }))
    .toEqual([{ persona: "pilot", pubkey: getPublicKey(pilot) }]); // Upgrade: empty registry, authorized pilot.
  const a = await enrollCaller({ home, config, persona: "alex", loadKey, updateMembership: membership });
  const b = await enrollCaller({ home, config, persona: "blair", loadKey, updateMembership: membership });
  expect(a).toEqual({ persona: "alex", pubkey: getPublicKey(alex) });
  expect(b).toEqual({ persona: "blair", pubkey: getPublicKey(blair) });
  expect(await enrollCaller({ home, config, persona: "alex", loadKey, updateMembership: membership })).toEqual(a);
  const aModels = JSON.parse(await readFile(join(home, ".fez/model-profiles", MODEL_PROVIDER, "alex/models.json"), "utf8"));
  const bModels = JSON.parse(await readFile(join(home, ".fez/model-profiles", MODEL_PROVIDER, "blair/models.json"), "utf8"));
  const aToken = aModels.providers[MODEL_PROVIDER].apiKey, bToken = bModels.providers[MODEL_PROVIDER].apiKey;
  expect(aToken).not.toBe(bToken);
  const gateway = await startMeshGateway({ host: provider.url, secretKey: pilot, token: config.token,
    resolveCaller: authorization => resolveCallerToken({ home, authorization, loadKey }) }); cleanup.push(gateway.close);
  const call = (token: string) => fetch(gateway.url + "/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  expect((await call(aToken)).status).toBe(200);
  expect((await call(bToken)).status).toBe(200);
  expect((await call("unknown-token")).status).toBe(401);
  expect((await call(config.token)).status).toBe(200);
  await membership(getPublicKey(alex), false);
  expect((await call(aToken)).status).toBe(403);
  expect((await call(bToken)).status).toBe(200);
  await revokeCaller({ home, persona: "pilot", legacyPersona: config.persona, loadKey, updateMembership: membership });
  expect((await call(config.token)).status).toBe(403);
  expect((await call(bToken)).status).toBe(200);
  expect(await gatewayReady(gateway.url)).toBe(true);
  const listed = await publicCallers({ home, legacyPersona: config.persona, loadKey, isMember: currentMember });
  expect(listed).toEqual([{ persona: "blair", pubkey: getPublicKey(blair) }]);
  await membership(getPublicKey(alex), true);
  await revokeCaller({ home, persona: "alex", updateMembership: membership });
  expect((await call(aToken)).status).toBe(401);
  expect((await call(bToken)).status).toBe(200);
  expect(await listCallers(home)).toEqual([{ persona: "blair", pubkey: getPublicKey(blair) }]);
  expect(JSON.stringify(await listCallers(home))).not.toContain(bToken);
});

it("writes a private profile without changing another persona and rejects unsafe names", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-profile-")); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const key = generateSecretKey();
  const config = { role: "gateway", port: 18092, model: "test", contextWindow: 8192, maxTokens: 32 } as GatewayConfig;
  const profile = join(home, ".fez/model-profiles", MODEL_PROVIDER, "alice");
  await enrollCaller({ home, config, persona: "alice", loadKey: () => Buffer.from(key).toString("hex"), updateMembership: async () => {} });
  const binding = JSON.parse(await readFile(join(profile, "profile.json"), "utf8"));
  const settings = JSON.parse(await readFile(join(profile, "settings.json"), "utf8"));
  expect(binding).toEqual({ provider: MODEL_PROVIDER, model: "test", persona: "alice" });
  expect(settings).toMatchObject({ defaultProvider: MODEL_PROVIDER, defaultModel: "test", defaultThinkingLevel: "off", retry: { enabled: false } });
  await writeFile(join(profile, "unrelated.txt"), "keep");
  await enrollCaller({ home, config, persona: "alice", loadKey: () => Buffer.from(key).toString("hex"), updateMembership: async () => {} });
  expect(await readFile(join(profile, "unrelated.txt"), "utf8")).toBe("keep");
  for (const name of ["a", "-alice", "Alice", "a/b", "a".repeat(33)]) expect(() => validatePersona(name)).toThrow();
  const models = join(profile, "models.json");
  await writeFile(models, '{"providers":{"secret":"very-private-token"},broken}');
  await expect(enrollCaller({ home, config, persona: "alice", loadKey: () => Buffer.from(key).toString("hex"), updateMembership: async () => {} }))
    .rejects.toThrow(/Invalid private model profile/);
  try { await enrollCaller({ home, config, persona: "alice", loadKey: () => Buffer.from(key).toString("hex"), updateMembership: async () => {} }); }
  catch (error) { expect(String(error)).not.toContain("very-private-token"); }
});

it("serializes caller and roster mutations with a useful busy error", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-lock-")); cleanup.push(() => rm(home, { recursive: true, force: true }));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const first = withCallerLock(home, async () => { entered(); await blocked; });
  await firstEntered;
  await expect(withCallerLock(home, async () => {})).rejects.toThrow(/already in progress/);
  release(); await first;
  await expect(withCallerLock(home, async () => "free")).resolves.toBe("free");
});

it("reports missing state as public JSON and keeps malformed private config out of errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "mesh-state-")); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const script = join(home, "cli.mjs"), config = join(home, "config.json");
  await build({ entryPoints: [join(process.cwd(), "../fez-mesh/src/cli.ts")], outfile: script, bundle: true, platform: "node", format: "esm",
    banner: { js: 'import { createRequire as meshRequire } from "node:module"; const require = meshRequire(import.meta.url);' } });
  const run = (name: string) => promisify(execFile)(process.execPath, [script, "state", "--json", "--config", name], { cwd: home, env: { ...process.env, HOME: home } });
  const missing = JSON.parse((await run(config)).stdout);
  expect(missing).toEqual({ configured: false, provider: MODEL_PROVIDER, model: "", label: "Mac mini", machine: "",
    status: "offline", detail: "Mini has not been configured", callersVerified: false, callers: [] });
  await writeFile(config, 'very-private-token');
  try { await run(config); } catch (error) {
    expect(String((error as { stderr?: string }).stderr)).not.toContain("very-private");
    return;
  }
  throw new Error("Malformed config was accepted");
});
