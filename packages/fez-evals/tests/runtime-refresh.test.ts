import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeRefresh } from "../../fez-acp/src/runtime-refresh.js";
import { requestInput } from "../../fez-client/src/agent-input.js";
import { K, type WireEvent } from "../../fez-client/src/index.js";

afterEach(() => vi.useRealTimers());

it("does not restart a newer executable against an older marker from an incomplete install", async () => {
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-refresh-"));
  const marker = path.join(dir, "VERSION"); fs.writeFileSync(marker, "0.84.2+svc12");
  let restarts = 0;
  const stop = new RuntimeRefresh().watch(marker, "0.84.2+svc13", () => true, () => restarts++);
  try {
    await vi.advanceTimersByTimeAsync(10000);
    expect(restarts).toBe(0);
    fs.writeFileSync(marker, "0.84.2+svc14");
    await vi.advanceTimersByTimeAsync(5000);
    expect(restarts).toBe(1);
  } finally { stop(); fs.rmSync(dir, { recursive: true }); }
});

it("waits for running, scheduled, and queued work before refreshing once", async () => {
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-refresh-"));
  const marker = path.join(dir, "VERSION");
  fs.writeFileSync(marker, "0.84.2+svc12");
  const refresh = new RuntimeRefresh();
  let queued = true;
  let release!: () => void;
  const work = refresh.run(() => new Promise<void>(resolve => { release = resolve; }));
  const events: string[] = [];
  const stop = refresh.watch(marker, "0.84.2+svc12", () => !queued, () => events.push("restarted"));
  try {
    fs.writeFileSync(marker, "0.84.2+svc13");
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual([]);
    release(); await work;
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual([]);
    queued = false;
    const scheduled = refresh.run(async () => { events.push("finished"); }, 6000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000); await scheduled;
    expect(events).toEqual(["finished", "restarted"]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(events).toEqual(["finished", "restarted"]);
  } finally { stop(); fs.rmSync(dir, { recursive: true }); }
});

it("waits for a receipt retry even after the question tool has returned", async () => {
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-refresh-"));
  const marker = path.join(dir, "VERSION"); fs.writeFileSync(marker, "0.84.2+svc12");
  const refresh = new RuntimeRefresh();
  let receive!: (event: WireEvent) => void;
  let receiptDone!: () => void;
  let requestId = "";
  const events: string[] = [];
  const stop = refresh.watch(marker, "0.84.2+svc12", () => true, () => events.push("restarted"));
  const pending = requestInput({
    pubkey: "b".repeat(64), encrypt: (_peer, text) => text, decrypt: (_peer, text) => text,
    subscribe: (_filters, callback) => { receive = callback; return () => {}; },
    publish: template => refresh.run(async () => {
      requestId = template.tags.find(tag => tag[0] === "d")![1];
      if (JSON.parse(template.content).status === "closed") await new Promise<void>(resolve => { receiptDone = resolve; });
      return { ...template, id: "e".repeat(64), pubkey: "b".repeat(64), created_at: Math.floor(Date.now() / 1000), sig: "" };
    }),
  }, "a".repeat(64), { message: "Pick", fields: [{ id: "pick", title: "Pick", type: "string", required: false }] });
  try {
    await vi.advanceTimersByTimeAsync(0);
    receive({ kind: K.INPUT_RESPONSE, id: "f".repeat(64), pubkey: "a".repeat(64), created_at: Math.floor(Date.now() / 1000), sig: "",
      tags: [["p", "b".repeat(64)], ["d", requestId]], content: JSON.stringify({ action: "accept", content: { pick: "yes" } }) });
    await expect(pending).resolves.toMatchObject({ action: "accept" });
    fs.writeFileSync(marker, "0.84.2+svc13");
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual([]);
    receiptDone();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(["restarted"]);
  } finally { stop(); fs.rmSync(dir, { recursive: true }); }
});

it("ignores incomplete installs and retries a failed refresh without losing the work gate", async () => {
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-refresh-"));
  const marker = path.join(dir, "VERSION");
  const refresh = new RuntimeRefresh();
  let attempts = 0;
  const stop = refresh.watch(marker, "0.84.2+svc12", () => true, () => { if (++attempts === 1) throw new Error("executable unavailable"); });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await vi.advanceTimersByTimeAsync(5000);
    fs.writeFileSync(marker, "");
    await vi.advanceTimersByTimeAsync(5000);
    fs.writeFileSync(marker, "0.84.2+svc12\n");
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempts).toBe(0);
    fs.writeFileSync(marker, "0.84.2+svc13\n");
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempts).toBe(1);
    await expect(refresh.run(async () => { throw new Error("turn failed"); })).rejects.toThrow("turn failed");
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempts).toBe(2);
  } finally { stop(); warning.mockRestore(); fs.rmSync(dir, { recursive: true }); }
});
