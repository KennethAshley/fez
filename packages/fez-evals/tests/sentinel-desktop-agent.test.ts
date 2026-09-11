import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
