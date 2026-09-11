import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { FezExtensionAPI, ScheduledTaskContext, CommandContext } from "../../fez-extension-api/src/headless.js";
import { readJobs, upsertJob, updatesChannel, setUpdatesChannel, type RidgesJob } from "../../fez-ridges/src/store.js";
import { statusReport } from "../../fez-ridges/src/status.js";
import { pollOnce, createPollerState } from "../../fez-ridges/src/poller.js";
vi.mock("@fezchat/wallet", () => ({ makeX402Deps: vi.fn(), x402FetchRaw: vi.fn() }));
import activate, { announceUpdates } from "../../fez-ridges/src/headless.js";

const dirs: string[] = [];
const dir = () => { const p = mkdtempSync(join(tmpdir(), "ridges-chat-")); dirs.push(p); return p; };
afterEach(() => { dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const job = (over: Partial<RidgesJob> = {}): RidgesJob => ({ id: "id", persona: "coder", issueUrl: "https://github.com/acme/repo/issues/1", repo: "acme/repo", issueNumber: 1,
  title: "Fix widgets", status: "working", usd: 2, txHash: "0xreceipt", providerId: "provider-id", ts: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z", ...over });
const response = (state = "open", merged_at: string | null = null) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify([
  { number: 8, title: "Fix #1", html_url: "https://github.com/acme/repo/pull/8", state, merged_at },
]) });

it("replaces panel information with persona-scoped paginated history and honest totals", () => {
  const home = dir();
  for (const status of ["working", "pr-open", "merged", "closed", "payment-unclear", "refused"] as const) upsertJob(home, job({ id: status, status, usd: status === "refused" ? undefined : 2, prUrl: "https://github.com/acme/repo/pull/8" }));
  upsertJob(home, job({ id: "private-other", persona: "other", title: "Other private job" }));
  const report = statusReport(home, { persona: "coder", limit: 50, now: Date.parse("2026-09-10T01:00:00Z") });
  for (const text of ["2 live", "1 merged", "$8.00 paid", "$2.00 payment unclear", "Base mainnet", "Fix widgets", "0xreceipt", "provider-id", "closed unmerged", "do not retry", "Created:", "updated:", "https://github.com/acme/repo/pull/8"]) expect(report).toContain(text);
  expect(report).not.toContain("Other private job");
  expect(statusReport(home, { persona: "coder", limit: 2 })).toContain("offset 2");
  expect(statusReport(home, { persona: "coder", offset: 4, limit: 2 })).toContain("Jobs 5–6 of 6");
});

it("announces PR open, merge and close with links/receipts, and retries failed delivery", async () => {
  const home = dir(); upsertJob(home, job());
  const state = createPollerState();
  await pollOnce({ dir: home, state, fetchImpl: async () => response() });
  await expect(announceUpdates(home, async () => { throw Error("offline"); })).rejects.toThrow("offline");
  expect(readJobs(home)[0].pendingUpdate).toBe(true);
  const deliver = vi.fn(async () => {});
  await announceUpdates(home, deliver);
  expect(deliver.mock.calls[0][0]).toContain("https://github.com/acme/repo/pull/8");
  expect(deliver.mock.calls[0][0]).toContain("0xreceipt");
  await pollOnce({ dir: home, state, fetchImpl: async () => response() });
  await announceUpdates(home, deliver);
  expect(deliver).toHaveBeenCalledTimes(1);
  await pollOnce({ dir: home, state, fetchImpl: async () => response("closed", "2026-09-10T00:01:00Z") });
  await announceUpdates(home, deliver);
  expect(deliver.mock.calls[1][0]).toContain("merged");
  upsertJob(home, job({ id: "closed", prNumber: 8, prUrl: "https://github.com/acme/repo/pull/8" }));
  await pollOnce({ dir: home, state, fetchImpl: async () => response("closed") });
  await announceUpdates(home, deliver);
  expect(deliver.mock.calls[2][0]).toContain("closed unmerged");
});

it("exposes unreadable repositories in both history and background messages", async () => {
  const home = dir(); upsertJob(home, job());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await pollOnce({ dir: home, fetchImpl: async () => ({ status: 404, headers: { get: () => null }, text: async () => "" }) });
  const send = vi.fn(async (_text: string) => {});
  await announceUpdates(home, send);
  expect(send.mock.calls[0][0]).toContain("tracking stopped");
  expect(statusReport(home)).toContain("Repository unreadable"); warn.mockRestore();
});

it("headless status is read-only and scheduled channel messages require explicit watch configuration", async () => {
  const home = dir(); vi.stubEnv("FEZ_RIDGES_HOME", home); upsertJob(home, job({ pendingUpdate: true, status: "merged" }));
  let command!: (args: string, ctx: CommandContext) => void | Promise<void>;
  let task!: (ctx: ScheduledTaskContext) => void | Promise<void>;
  const storage = new Map<string, unknown>();
  const channels = { list: async () => [{ id: "chosen", name: "Private jobs" }], say: vi.fn(async (_id: string, _text: string) => "event") };
  const api = { registerCommand: (_: string, f: typeof command) => { command = f; }, registerScheduledTask: (_: string, _ms: number, f: typeof task) => { task = f; }, channels,
    storage: { get: async (k: string) => storage.get(k), set: async (k: string, v: unknown) => { storage.set(k, v); }, delete: async (k: string) => { storage.delete(k); } },
  } as unknown as FezExtensionAPI;
  activate(api);
  const reply = vi.fn();
  await command("status", { reply }); expect(reply.mock.calls[0][0]).toContain("0xreceipt");
  await task({ channels } as unknown as ScheduledTaskContext); expect(channels.say).not.toHaveBeenCalled();
  await command("watch unknown", { reply }); expect(updatesChannel(home)).toBeUndefined();
  await command("watch chosen", { reply }); await task({ channels } as unknown as ScheduledTaskContext);
  expect(channels.say).toHaveBeenCalledWith("chosen", expect.stringContaining("merged"));
  await command("watch off", { reply }); expect(updatesChannel(home)).toBeUndefined();
});

it("stops an in-flight batch when updates are disabled, preserving undelivered jobs", async () => {
  const home = dir(); setUpdatesChannel(home, "chosen");
  upsertJob(home, job({ id: "a", pendingUpdate: true })); upsertJob(home, job({ id: "b", pendingUpdate: true }));
  const send = vi.fn(async () => { setUpdatesChannel(home, null); });
  await announceUpdates(home, send, () => updatesChannel(home) === "chosen");
  expect(send).toHaveBeenCalledTimes(1);
  expect(readJobs(home).find(j => j.id === "b")?.pendingUpdate).toBe(true);
});

it("reports stalled work once even when GitHub keeps returning 304", async () => {
  const home = dir(); upsertJob(home, job()); const state = createPollerState();
  const fetchImpl = async () => ({ status: 304, headers: { get: () => null }, text: async () => "" });
  const send = vi.fn(async (_text: string) => {});
  await pollOnce({ dir: home, state, fetchImpl, now: () => "2026-09-10T02:00:00Z" });
  await announceUpdates(home, send);
  expect(send.mock.calls[0][0]).toContain("No matching PR after one hour");
  await pollOnce({ dir: home, state, fetchImpl, now: () => "2026-09-10T03:00:00Z" });
  await announceUpdates(home, send); expect(send).toHaveBeenCalledTimes(1);
});

it("removes the GUI manifest and dependency while retaining MCP, headless and mining parts", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../fez-ridges/package.json", import.meta.url), "utf8"));
  expect(pkg.fez.parts.gui).toBeUndefined(); expect(pkg.fez.permissions).not.toContain("ui");
  expect(pkg.fez.parts).toMatchObject({ headless: "dist/headless.js", miner: "dist/miner.js", skill: { command: "node" }, background: true });
  expect(pkg.dependencies["@fezchat/ui"]).toBeUndefined(); expect(pkg.devDependencies.react).toBeUndefined();
});
