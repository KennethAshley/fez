import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection } from "@fezchat/protocol";
import { MiniRelay, waitFor } from "./mini-relay.js";
import { registeredAgent } from "../../fez-sentinel/src/index.js";
import { SummonEngine, type SummonHost } from "../../../src/agent/summon.js";

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit"); child.kill(); await exited;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function desktopAgent() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-desktop-summon-")); roots.push(home);
  fs.mkdirSync(path.join(home, "bin")); fs.mkdirSync(path.join(home, "agents"));
  const binary = path.join(home, "bin", "fez-agent");
  fs.symlinkSync(process.execPath, binary);
  const child = spawn(binary, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); children.push(child);
  await once(child, "spawn");
  const row = { persona: "fez", channels: ["general"], repo: "demo", line: "main", pid: child.pid! };
  fs.writeFileSync(path.join(home, "agents", "fez.pid"), String(child.pid));
  fs.writeFileSync(path.join(home, "desktop-agents.json"), JSON.stringify([row]));
  return { home, row, child };
}

it("a bridge task brings a desktop-started agent into its new channel without dropping the original channel or checkout", async () => {
  const { home } = await desktopAgent();
  const owner = "aa".repeat(32), worker = "bb".repeat(32);
  let restarted: { channels: string[]; work: unknown } | undefined;
  const host: SummonHost = {
    ownerPubkey: owner, personaExists: name => name === "fez", personaPubkey: async () => worker,
    agentAlive: () => true, registryEntry: name => registeredAgent(name, home),
    restart: async (_name, channels, work) => { restarted = { channels, work }; },
    spawn: async () => { throw new Error("must transfer the live agent"); },
    query: async () => [], publish: async () => {}, announceTimeout: () => {},
  };
  const engine = new SummonEngine(host); engine.noteAnnouncement(worker, "fez");
  await engine.handleEvent({ kind: 47103, pubkey: owner, content: "hello",
    tags: [["h", "slack"], ["p", worker], ["task", worker], ["result-handler", "external"]] });
  expect(restarted).toEqual({ channels: ["general", "slack"], work: { repo: "demo", line: "main" } });
});

it("ignores desktop rows for extension binaries, reused PIDs, or an old persona instance", async () => {
  const { home, row } = await desktopAgent();
  for (const invalid of [{ ...row, bin: "fez-bazaar-miner" }, { ...row, pid: process.pid }]) {
    fs.writeFileSync(path.join(home, "desktop-agents.json"), JSON.stringify([invalid]));
    expect(registeredAgent("fez", home)).toBeUndefined();
  }
  fs.writeFileSync(path.join(home, "desktop-agents.json"), JSON.stringify([row]));
  fs.writeFileSync(path.join(home, "agents", "fez.pid"), String(process.pid));
  expect(registeredAgent("fez", home)).toBeUndefined();
  fs.writeFileSync(path.join(home, "desktop-agents.json"), JSON.stringify([{ ...row, pid: process.pid }]));
  expect(registeredAgent("fez", home)).toBeUndefined(); // a matching PID file is not enough: this is the test runner
  fs.writeFileSync(path.join(home, "desktop-agents.json"), "{}");
  expect(registeredAgent("fez", home)).toBeUndefined();
});


it("sentinel ignores task history at startup but summons a newly delivered old-timestamp task", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-sentinel-late-")); roots.push(home);
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  fs.mkdirSync(path.join(repo, "node_modules/.cache"), { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(repo, "node_modules/.cache/sentinel-late-")); roots.push(bundleDir);
  const bundle = path.join(bundleDir, "sentinel.mjs"), marker = path.join(home, "spawned");
  await build({ entryPoints: [path.join(repo, "packages/fez-sentinel/src/index.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle,
    alias: { "@fezchat/protocol": path.join(repo, "src/index.ts") } });
  const ownerKey = generateSecretKey(), workerKey = generateSecretKey();
  const owner = getPublicKey(ownerKey), worker = getPublicKey(workerKey);
  const fez = path.join(home, ".fez");
  for (const dir of ["bin", "personas", "agents"]) fs.mkdirSync(path.join(fez, dir), { recursive: true });
  fs.writeFileSync(path.join(fez, "default.key"), Buffer.from(ownerKey).toString("hex"));
  fs.writeFileSync(path.join(fez, "agents/probe.key"), Buffer.from(workerKey).toString("hex"));
  fs.writeFileSync(path.join(fez, "personas/probe.md"), "---\nharness: claude\n---\nTest worker");
  fs.writeFileSync(path.join(fez, "bin/fez-agent"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(marker)}, process.env.FEZ_AGENT_PERSONA + "\\n");
`, { mode: 0o700 });
  const relay = new MiniRelay(); await relay.start(); relay.workspace = { owner };
  const wire = new RelayConnection({ urls: [relay.url] }); await wire.connect();
  const old = Math.floor(Date.now() / 1000) - 50 * 3600;
  relay.events.push(finalizeEvent({ kind: 47000, created_at: old, content: '{"name":"probe"}', tags: [] }, workerKey));
  const task = (content: string) => finalizeEvent({ kind: 47103, created_at: old, content,
    tags: [["h", "work"], ["p", worker], ["task", worker]] }, ownerKey);
  relay.events.push(task("already stored"));
  const child = spawn(process.execPath, [bundle], { env: { PATH: process.env.PATH, HOME: home, FEZ_KEYSTORE: "file", FEZ_RELAY: relay.url }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  try {
    await waitFor(() => output.includes("watching:"), 15000, "sentinel ready");
    expect(fs.existsSync(marker)).toBe(false);
    await wire.publish(task("late delivery"));
    await waitFor(() => fs.existsSync(marker), 5000, "late task summons worker");
    expect(fs.readFileSync(marker, "utf8").trim()).toBe("probe");
  } catch (error) { throw new Error(`${String(error)}\n${output}`, { cause: error }); }
  finally {
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    wire.disconnect(); await relay.stop();
  }
}, 30000);
