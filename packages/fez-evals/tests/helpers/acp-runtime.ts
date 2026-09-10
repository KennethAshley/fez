import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { CapabilityClient, RelayConnection } from "@fezchat/protocol";
import { MiniRelay, waitFor } from "../mini-relay.js";

export const TEST_CHANNEL = "00000000-0000-4000-8000-000000000001";
export const OTHER_CHANNEL = "00000000-0000-4000-8000-000000000002";
export interface RuntimePrompt { type: "prompt"; id: number; session: number; instruction: string }

export async function startAcpRuntime(onBusy: "steer" | "queue" = "steer", { relayInfoAvailable = true } = {}) {
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  const cache = path.join(repo, "node_modules/.cache");
  await fs.mkdir(cache, { recursive: true });
  const bundleDir = await fs.mkdtemp(path.join(cache, "acp-runtime-"));
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "fez-acp-runtime-"));
  const bundle = path.join(bundleDir, "runtime.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./acp-runtime-child.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "node", packages: "external", outfile: bundle,
    alias: { "@fezchat/protocol": path.join(repo, "src/index.ts") },
  });
  const relay = new MiniRelay();
  await relay.start();
  const owner = new CapabilityClient({ privateKey: Buffer.from(generateSecretKey()).toString("hex"), relay: relay.url });
  const agentKey = generateSecretKey();
  const agentPk = getPublicKey(agentKey);
  const ownerPk = owner.getPubkey();
  relay.workspace = relayInfoAvailable ? { owner: ownerPk } : {};
  relay.events.push(owner.signEvent({ kind: 47102, tags: [["d", "roster"], ["p", ownerPk, "owner"], ["p", agentPk, "bot"]], content: "" }));
  await fs.mkdir(path.join(testHome, ".fez/personas"), { recursive: true });
  await fs.mkdir(path.join(testHome, ".fez/agents"), { recursive: true });
  await fs.writeFile(path.join(testHome, ".fez/personas/scope-test.md"), "---\nharness: test-harness\n---\nRuntime routing test.\n");
  await fs.writeFile(path.join(testHome, ".fez/agents/scope-test.key"), Buffer.from(agentKey).toString("hex"), { mode: 0o600 });
  const wire = new RelayConnection({ urls: [relay.url] });
  await wire.connect();
  const child = fork(bundle, [], {
    cwd: testHome, silent: true, execArgv: [],
    env: {
      PATH: process.env.PATH,
      FEZ_TEST_HOME: testHome, FEZ_KEYSTORE: "file", FEZ_RELAY: relay.url,
      FEZ_AGENT_PERSONA: "scope-test", FEZ_AGENT_OWNER: ownerPk,
      FEZ_AGENT_CHANNELS: `${TEST_CHANNEL},${OTHER_CHANNEL}`, FEZ_AGENT_ON_BUSY: onBusy,
    },
  });
  const prompts: RuntimePrompt[] = [];
  const aborted: number[] = [];
  let ready = false;
  let output = "";
  child.stdout?.on("data", (data) => { output += data; });
  child.stderr?.on("data", (data) => { output += data; });
  child.on("message", (message: RuntimePrompt | { type: "ready" } | { type: "aborted"; id: number }) => {
    if (message.type === "ready") ready = true;
    else if (message.type === "prompt") prompts.push(message);
    else aborted.push(message.id);
  });
  const wait = async (predicate: () => boolean, label: string) => {
    try { await waitFor(() => predicate() || child.exitCode !== null, 15_000, label); }
    catch (error) { throw new Error(`${String(error)}\n${output}`, { cause: error }); }
    if (child.exitCode !== null) throw new Error(`runtime exited ${child.exitCode}\n${output}`);
  };
  const stop = async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    wire.disconnect();
    await relay.stop();
    await fs.rm(testHome, { recursive: true, force: true });
    await fs.rm(bundleDir, { recursive: true, force: true });
  };
  try { await wait(() => ready, "runtime subscriptions ready"); }
  catch (error) { await stop(); throw error; }
  return {
    relay, owner, agentPk, prompts, aborted, wait, stop,
    get output() { return output; },
    publish: wire.publish.bind(wire),
    async send(content: string, tags: string[][] = [["h", TEST_CHANNEL]], kind = 47103) {
      const event = owner.signEvent({ kind, tags, content });
      await wire.publish(event);
      return event;
    },
    release(prompt: RuntimePrompt, reply = "fixture reply", error?: string) { child.send({ id: prompt.id, reply, error }); },
    async cancel() {
      await wire.publish(owner.signEvent({
        kind: 20005, tags: [["p", agentPk]],
        content: owner.encryptTo(agentPk, JSON.stringify({ cmd: "cancel", ts: Date.now() })),
      }));
    },
  };
}
