import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { CapabilityClient, type NostrAccess } from "@fezchat/protocol";
import { acquireBackgroundOwnership, assertHeadlessOwnership, startScheduledTasks } from "../../fez-sentinel/src/background.js";

const roots: string[] = [];
const stops: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
function home() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "fez-background-")); roots.push(root); return root; }
function nostr(): NostrAccess {
  const client = new CapabilityClient({ relay: "ws://127.0.0.1:1", privateKey: "1".repeat(64) });
  return {
    pubkey: client.getPubkey(), publish: async template => client.signEvent(template),
    signEvent: template => client.signEvent(template), query: async () => [],
    subscribe: () => () => {}, encrypt: () => "", decrypt: () => "",
    sendDm: async () => "", unwrapDm: () => undefined,
  };
}

it("starts immediately, clamps intervals to one minute, and never overlaps a running task", async () => {
  vi.useFakeTimers();
  let calls = 0, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const stop = startScheduledTasks([{ name: "slow", everyMs: 1, run: async () => { calls++; await waiting; } }], nostr(), async () => "a".repeat(64));
  stops.push(stop);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(calls).toBe(1);
  release();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toBe(2);
  await stop();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(calls).toBe(2);
});

it("retries workspace discovery on each tick, keeping local identity separate from workspace authority", async () => {
  vi.useFakeTimers();
  const backend = nostr(), foreignOwner = "a".repeat(64), queried: unknown[] = [], published: unknown[] = [];
  backend.query = async filters => { queried.push(filters); return []; };
  backend.publish = async template => { published.push(template); return backend.signEvent(template); };
  let discovered = false;
  const owners: string[] = [];
  const stop = startScheduledTasks([{ name: "channel", everyMs: 60_000, run: async ctx => {
    owners.push(ctx.ownerPubkey);
    await ctx.channels.ensure({ name: "bridge" });
  } }], backend, async () => discovered ? foreignOwner : undefined);
  stops.push(stop);
  await vi.advanceTimersByTimeAsync(0);
  discovered = true;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(owners).toEqual([backend.pubkey, backend.pubkey]);
  expect(queried).toEqual([[{ kinds: [47101], authors: [""], limit: 500 }], [{ kinds: [47101], authors: [foreignOwner], limit: 500 }]]);
  expect(published).toEqual([]);
});

it("does not start a task after stop while workspace discovery was pending", async () => {
  vi.useFakeTimers();
  let release!: (value: string) => void, calls = 0;
  const waiting = new Promise<string>(resolve => { release = resolve; });
  const stop = startScheduledTasks([{ name: "late", everyMs: 60_000, run: () => { calls++; } }], nostr(), () => waiting);
  const stopped = stop();
  release("a".repeat(64));
  await stopped;
  expect(calls).toBe(0);
});

it("allows one background owner and releases ownership on stop", async () => {
  const root = home();
  const release = await acquireBackgroundOwnership(root); stops.push(release);
  const alias = `${root}-alias`; fs.symlinkSync(root, alias); roots.push(alias);
  await expect(acquireBackgroundOwnership(alias)).rejects.toThrow(/background.*already running/i);
  await expect(acquireBackgroundOwnership(root)).rejects.toThrow(/background.*already running/i);
  await release();
  const next = await acquireBackgroundOwnership(root); stops.push(next);
});

it("headless startup refuses only a live desktop PID with the exact executable", async () => {
  const root = home();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  stops.push(async () => { const exited = once(child, "exit"); child.kill(); await exited; });
  const pid = child.pid!;
  const receipt = path.join(root, "desktop-runtime.json");
  const executable = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim();
  fs.writeFileSync(receipt, JSON.stringify({ pid, executable }));
  expect(() => assertHeadlessOwnership(root)).toThrow(/Fez desktop owns local runtime; quit Fez before headless/);
  for (const row of [{ pid, executable: `${executable}-other` }, { pid: 99999999, executable }, { pid: 1, executable }]) {
    fs.writeFileSync(receipt, JSON.stringify(row));
    expect(() => assertHeadlessOwnership(root)).not.toThrow();
  }
});
