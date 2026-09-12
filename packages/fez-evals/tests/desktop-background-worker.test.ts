import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { CapabilityClient } from "@fezchat/protocol";
import { acquireBackgroundOwnership } from "../../fez-sentinel/src/background.js";

const key = "1".repeat(64);
const owner = new CapabilityClient({ relay: "ws://127.0.0.1:1", privateKey: key }).getPubkey();
const sentinel = fileURLToPath(new URL("../../fez-sentinel/", import.meta.url));
let compiled: string, buildDir: string;
const roots: string[] = [], children: ChildProcess[] = [], cleanup: (() => void | Promise<void>)[] = [];
const orphans: number[] = [];
beforeAll(async () => {
  buildDir = fs.mkdtempSync(path.join(sentinel, ".worker-test-"));
  compiled = path.join(buildDir, "worker.mjs");
  await build({ entryPoints: [path.join(sentinel, "src/desktop.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile: compiled });
});
afterAll(() => { if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true }); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  }
  for (const pid of orphans.splice(0)) { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (const stop of cleanup.splice(0)) await stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function localRelay() {
  const wire: unknown[][] = [];
  let connections = 0;
  const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/nostr+json"); res.end(JSON.stringify({ pubkey: owner })); });
  const ws = new WebSocketServer({ server });
  ws.on("connection", socket => { connections++; socket.on("message", data => {
    const frame = JSON.parse(data.toString()); wire.push(frame);
    if (frame[0] === "EVENT") socket.send(JSON.stringify(["OK", frame[1].id, true, ""]));
    if (frame[0] === "REQ") socket.send(JSON.stringify(["EOSE", frame[1]]));
  }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(async () => { ws.clients.forEach(socket => socket.terminate()); await new Promise<void>(resolve => ws.close(() => server.close(() => resolve()))); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing relay address");
  return { url: `ws://127.0.0.1:${address.port}`, wire, connections: () => connections };
}
async function fixture() {
  const relay = await localRelay();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-desktop-background-")); roots.push(home);
  const fez = path.join(home, ".fez"), ext = path.join(fez, "extensions");
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(path.join(fez, "default.key"), key, { mode: 0o600 });
  const settings = { relays: [relay.url], backgroundExtensions: ["probe", "unselected"], extensionPermissions: { probe: ["background", "publish"] } };
  fs.writeFileSync(path.join(fez, "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(path.join(ext, "probe.mjs"), `export default api => {
    api.registerScheduledTask("probe", 60000, async ctx => {
      await ctx.nostr.publish({ kind: 20003, tags: [], content: "activated" });
    });
  };`);
  fs.writeFileSync(path.join(ext, "unselected.mjs"), "export default () => { throw new Error('must not load unselected extension'); };\n");
  return { ...relay, home, fez, ext, settings };
}
function launch(home: string, extra: NodeJS.ProcessEnv = {}, entry = compiled) {
  const binary = entry === compiled ? process.env.FEZ_BACKGROUND_TEST_BINARY : undefined;
  const child = spawn(binary ?? process.execPath, binary ? [] : [entry], {
    env: { ...process.env, HOME: home, FEZ_KEYSTORE: "file", FEZ_RELAY: "ws://127.0.0.1:1", FEZ_DESKTOP_OWNER: owner,
      FEZ_DESKTOP_PARENT_PID: String(process.pid), FEZ_BACKGROUND_EXTENSIONS: "probe", ...extra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let out = "", err = "";
  child.stdout!.on("data", data => { out += data; }); child.stderr!.on("data", data => { err += data; });
  const exited = once(child, "exit");
  return { child, exited, output: () => out, errors: () => err };
}
async function ready(worker: ReturnType<typeof launch>) {
  await expect.poll(() => worker.child.exitCode === null ? worker.output() : worker.errors(), { timeout: 5000 }).toContain("FEZ_BACKGROUND_READY\n");
}

it("prepares alongside the previous host, emits no events or summons until start, then stops on stdin EOF", async () => {
  const f = await fixture();
  const release = await acquireBackgroundOwnership(f.fez); cleanup.push(release);
  const worker = launch(f.home);
  await ready(worker);
  expect(worker.output()).toBe("FEZ_BACKGROUND_READY\n");
  expect(f.wire).toEqual([]);
  expect(fs.existsSync(path.join(f.fez, "sentinel.pid"))).toBe(false);
  await release();
  worker.child.stdin!.write("start\n");
  await expect.poll(worker.output).toBe("FEZ_BACKGROUND_READY\nFEZ_BACKGROUND_STARTED\n");
  await expect.poll(() => f.wire.filter(frame => frame[0] === "EVENT").length).toBe(1);
  expect(f.wire.map(frame => frame[0])).toEqual(["EVENT"]);
  worker.child.stdin!.end();
  expect((await worker.exited)[0]).toBe(0);
  expect(fs.existsSync(path.join(f.fez, "sentinel.pid"))).toBe(false);
});

it("follows settings relay changes despite an inherited FEZ_RELAY pin", async () => {
  const f = await fixture(), next = await localRelay(), worker = launch(f.home);
  await ready(worker);
  fs.writeFileSync(path.join(f.fez, "settings.json"), JSON.stringify({ ...f.settings, relays: [next.url] }));
  await expect.poll(worker.errors).toContain(next.url);
  worker.child.stdin!.write("start\n");
  await expect.poll(() => next.wire.some(frame => frame[0] === "EVENT")).toBe(true);
  expect(f.wire).toEqual([]);
  worker.child.kill("SIGTERM");
  expect((await worker.exited)[0]).toBe(0);
});

it("uses a relay change saved while the initial connection was still starting", async () => {
  const f = await fixture(), next = await localRelay(), worker = launch(f.home);
  await expect.poll(f.connections).toBe(1);
  fs.writeFileSync(path.join(f.fez, "settings.json"), JSON.stringify({ ...f.settings, relays: [next.url] }));
  await ready(worker);
  worker.child.stdin!.write("start\n");
  await expect.poll(() => next.wire.some(frame => frame[0] === "EVENT")).toBe(true);
  expect(f.wire).toEqual([]);
});

it.each(["missing", "broken", "wrong-owner", "wrong-parent", "disabled"])("refuses readiness before side effects for %s startup", async problem => {
  const f = await fixture();
  const env: NodeJS.ProcessEnv = {};
  if (problem === "missing") fs.unlinkSync(path.join(f.ext, "probe.mjs"));
  if (problem === "broken") fs.writeFileSync(path.join(f.ext, "probe.mjs"), "export default () => { throw new Error('activation failed'); };\n");
  if (problem === "wrong-owner") env.FEZ_DESKTOP_OWNER = "a".repeat(64);
  if (problem === "wrong-parent") env.FEZ_DESKTOP_PARENT_PID = "1";
  if (problem === "disabled") env.FEZ_BACKGROUND_EXTENSIONS = "disabled";
  const worker = launch(f.home, env);
  expect((await worker.exited)[0]).toBe(1);
  expect(worker.output()).toBe("");
  expect(worker.errors()).toMatch(/missing|activation failed|owner|parent|not enabled/i);
  expect(f.wire).toEqual([]);
});

it("a crashed task host releases ownership without a stale lock file", async () => {
  const f = await fixture(), worker = launch(f.home); await ready(worker);
  worker.child.stdin!.write("start\n");
  await expect.poll(worker.output).toContain("FEZ_BACKGROUND_STARTED\n");
  worker.child.kill("SIGKILL"); await worker.exited;
  const release = await acquireBackgroundOwnership(f.fez); cleanup.push(release);
});

it("refuses activation while another task host owns the lock", async () => {
  const f = await fixture(), release = await acquireBackgroundOwnership(f.fez); cleanup.push(release);
  const worker = launch(f.home); await ready(worker);
  worker.child.stdin!.write("start\n");
  expect((await worker.exited)[0]).toBe(1);
  expect(worker.output()).toBe("FEZ_BACKGROUND_READY\n");
  expect(worker.errors()).toMatch(/already running/i);
  expect(f.wire).toEqual([]);
});

it("exits when its actual parent dies even if stdin remains open", async () => {
  const f = await fixture();
  const wrapper = path.join(buildDir, "parent.mjs");
  fs.writeFileSync(wrapper, `import { spawn } from "node:child_process";
    const child = spawn(${JSON.stringify(process.env.FEZ_BACKGROUND_TEST_BINARY ?? process.execPath)}, ${JSON.stringify(process.env.FEZ_BACKGROUND_TEST_BINARY ? [] : [compiled])}, { env: { ...process.env, FEZ_DESKTOP_PARENT_PID: String(process.pid) }, detached: true, stdio: ["pipe", "inherit", "inherit"] });
    console.log("WORKER_PID=" + child.pid);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { detached: true, stdio: [child.stdin, "ignore", "ignore"] });
    console.log("HOLDER_PID=" + holder.pid);
    child.stdin.write("start\\n");
    setInterval(() => {}, 1000);`);
  const worker = launch(f.home, {}, wrapper); await ready(worker);
  const pid = Number(worker.output().match(/WORKER_PID=(\d+)/)?.[1]); orphans.push(pid);
  const holder = Number(worker.output().match(/HOLDER_PID=(\d+)/)?.[1]); orphans.push(holder);
  expect(holder).toBeGreaterThan(1);
  worker.child.kill("SIGKILL"); await worker.exited;
  await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
});
