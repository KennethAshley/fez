// @vitest-environment jsdom
/// <reference lib="dom" />
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubmissionStatus } from "../../fez-extension-api/src/miner.js";
import type { MinerEntry } from "../../fez-mining/src/state.js";

// Mount the browser bundle using the host's React; all host IO is fake.
const hostRequire = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = hostRequire("react");
const { createRoot } = hostRequire("react-dom/client");
const { act } = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const code = execFileSync(createRequire(resolve(__dirname, "test.cjs")).resolve("esbuild/bin/esbuild"), [
  resolve(__dirname, "../../fez-mining/src/gui.tsx"), "--bundle", "--format=iife",
  "--global-name=__fezExt", "--platform=browser", "--jsx-factory=h",
], { encoding: "utf8" });
const pending: SubmissionStatus = {
  hotkey: "public-hotkey", phase: "pending", checkedAt: "2026-09-10T10:00:00Z",
  activeVersionId: "old", nextUploadAt: "2026-09-11T10:00:00Z", detail: "Awaiting validator activation",
  versions: [
    { id: "old", name: "old.py", version: 1, createdAt: "2026-09-09T10:00:00Z", activatedAt: "2026-09-09T11:00:00Z" },
    { id: "new", name: "new.py", version: 2, createdAt: "2026-09-10T10:00:00Z", activatedAt: null },
  ],
};
const entry = (): MinerEntry => ({ netuid: 777, persona: "scout", mode: "submission", desired: "stopped", hotkey: pending.hotkey, submission: pending });
const disposers: (() => void)[] = [];
afterEach(async () => { await act(async () => { for (const dispose of disposers.splice(0)) dispose(); }); vi.useRealTimers(); });

async function mount(options: { fleet?: MinerEntry[]; liveFleet?: MinerEntry[]; thread?: boolean; cachedSubmission?: boolean; refreshedSubmission?: boolean } = {}) {
  const state = {
    miners: options.fleet ?? [entry()], subnets: [{ netuid: 777, name: "Submission fixture" }], covered: [777],
    submissionNetuids: options.cachedSubmission === false ? [] : [777], requirementsByNetuid: { 777: { gpu: "A100" } },
  };
  let snapshot = pending;
  let failure = "";
  const receipt = { sha256: "a".repeat(64), prediction: 0.42, detail: "Isolated Docker test passed" };
  let deferTest: (() => Promise<typeof receipt>) | undefined;
  let deferStatus: (() => Promise<SubmissionStatus>) | undefined;
  const calls: string[][] = [];
  const toast = vi.fn();
  const invite = vi.fn(async () => "invited");
  let markdown = "---\nharness: codex\n---\nScout";
  const update = vi.fn(async (_persona: string, next: string) => { markdown = next; });
  const run = async (bin: string, args: string[]) => {
    expect(bin).toBe("fez-mine");
    calls.push(args);
    let result: unknown;
    if (args[0] === "status") result = (options.liveFleet ?? state.miners).map(m => ({ ...m, alive: false }));
    else if (args[0] === "subnets") result = { ...state, submissionNetuids: options.refreshedSubmission === false ? [] : [777] };
    else if (args[0] === "describe") result = { netuid: 777, mode: "submission", network: "test", config: [] };
    else if (args[0] === "do-token-status") result = { present: false };
    else if (args[0] === "cost") result = { netuid: 777, rao: "123000000", tao: "0.123" };
    else if (args[0] === "submission") {
      if (failure) return { code: 1, stdout: "", stderr: failure };
      if (args[1] === "test") result = deferTest ? await deferTest() : receipt;
      else result = deferStatus ? await deferStatus() : snapshot;
    } else throw Error("Unexpected process command: " + args.join(" "));
    return { code: 0, stdout: JSON.stringify(result), stderr: "" };
  };
  let nav!: () => unknown;
  let thread!: (props: object) => unknown;
  const denied = () => { throw Error("Unexpected network"); };
  new Function("fetch", "WebSocket", code + ";return __fezExt")(denied, denied).default({
    React, storage: { get: async (key: keyof typeof state) => state[key] }, processes: { run }, toast,
    personas: { list: async () => ["scout", "other"], invite, read: async () => markdown, update },
    registerNavView: (_id: string, _label: object, render: () => unknown) => { nav = render; },
    registerThreadView: (_id: string, _match: unknown, render: typeof thread) => { thread = render; },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let disposed = false;
  const dispose = () => { if (!disposed) { root.unmount(); host.remove(); disposed = true; } };
  disposers.push(dispose);
  await act(async () => { root.render(options.thread ? thread({ channelId: "c", rootId: "r", rootContent: "⛏ mining · netuid 777 · persona scout" }) : nav()); });
  const button = (label: string) => {
    const found = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.trim() === label);
    expect(found, "button " + label + "; rendered: " + host.textContent).toBeDefined();
    return found!;
  };
  const click = async (label: string) => { const b = button(label); expect(b.disabled).toBe(false); await act(async () => b.click()); };
  const change = async (label: string, value: string) => {
    const input = host.querySelector('[aria-label="' + label + '"]') as HTMLInputElement | HTMLSelectElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  return { host, calls, toast, invite, update, button, click, change, dispose, receipt,
    fail: (message: string) => { failure = message; }, status: (value: SubmissionStatus) => { snapshot = value; },
    deferTest: (fn: typeof deferTest) => { deferTest = fn; }, deferStatus: (fn: typeof deferStatus) => { deferStatus = fn; } };
}

function noProcessCommands(calls: string[][]) {
  expect(calls.filter(args => ["start", "stop", "machines", "balance", "logs", "config", "metagraph"].includes(args[0]))).toEqual([]);
}

describe("generic submission mining GUI", () => {
  it("keeps stopped submissions in the fleet, shows pending/latest and the old active version, and manages without chat", async () => {
    const p = await mount();
    expect(p.host.textContent).toContain("pending");
    expect(p.host.textContent).toMatch(/Latest.*new.py/);
    expect(p.host.textContent).toMatch(/Active.*old.py/);
    expect(p.host.querySelector('[title="dead"]')).toBeNull();
    expect(p.host.textContent).not.toMatch(/Restart|Not running|unregistered/);
    await p.click("Manage");
    expect(p.host.textContent).toContain("Submission miner");
    expect(p.host.textContent).toContain("Activation is not proof of execution");
    expect(p.host.textContent).toContain("Awaiting validator activation");
    expect(p.invite).toHaveBeenCalledWith("scout", "bot");
    expect(p.update.mock.calls[0][1]).toContain("mining=npm:@fezchat/mining");
    await p.change("Submission persona", "other");
    await p.click("Manage");
    expect((p.host.querySelector('[aria-label="Submission persona"]') as HTMLSelectElement).value).toBe("scout");
    noProcessCommands(p.calls);
  });

  it("routes refreshed metadata past machine rental and confirms registration only after live cost", async () => {
    const p = await mount({ fleet: [], cachedSubmission: false });
    await p.click("Launch");
    expect(p.host.textContent).toContain("Submission miner");
    expect(p.host.textContent).not.toContain("A100");
    await p.change("Submission persona", "other");
    expect(p.calls.some(a => a[0] === "submission" && a[1] === "register")).toBe(false);
    p.fail("No existing hotkey");
    await p.click("Refresh / adopt");
    expect(p.host.textContent).toContain("No existing hotkey");
    p.fail("");
    await p.click("Register");
    expect(p.host.textContent).toContain("0.123");
    expect(p.host.textContent).toMatch(/burn/i);
    expect(p.calls.some(a => a[0] === "submission" && a[1] === "register")).toBe(false);
    await p.click("Confirm registration");
    expect(p.calls).toContainEqual(["submission", "register", "--netuid", "777", "--persona", "other", "--json"]);
    noProcessCommands(p.calls);
  });

  it("reuses the panel in threads without process controls, polls every 30s, and cleans up", async () => {
    vi.useFakeTimers();
    const p = await mount({ thread: true });
    expect(p.host.textContent).toContain("Submission miner");
    noProcessCommands(p.calls);
    const count = () => p.calls.filter(a => a[0] === "submission" && a[1] === "status").length;
    const before = count();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(count()).toBe(before);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(count()).toBe(before + 1);
    await act(async () => p.dispose());
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(count()).toBe(before + 1);
    expect(p.calls.some(a => a[0] === "submission" && ["test", "submit", "register"].includes(a[1]))).toBe(false);
  });

  it("requires absolute paths and successful tests, confirms the hash-bound upload, and clears edited receipts", async () => {
    const p = await mount({ thread: true });
    expect(p.host.textContent).toMatch(/local Docker/);
    await p.change("Source file", "relative.py");
    expect(p.button("Test").disabled).toBe(true);
    await p.change("Source file", "/tmp/candidate.py");
    await p.click("Test");
    expect(p.host.textContent).toContain("a".repeat(64));
    expect(p.host.textContent).toContain("0.42");
    await p.click("Refresh / adopt");
    expect(p.calls.filter(a => a[0] === "submission" && a[1] === "test")).toHaveLength(1);
    await p.click("Submit tested version");
    expect(p.host.textContent).toMatch(/schedules|replaces/);
    expect(p.host.textContent).toContain("2026-09-11T10:00:00Z");
    expect(p.calls.some(a => a[1] === "submit")).toBe(false);
    await p.click("Confirm submission");
    expect(p.calls).toContainEqual(["submission", "submit", "--netuid", "777", "--persona", "scout", "--json", "--file", "/tmp/candidate.py", "--sha256", "a".repeat(64)]);
    await p.click("Test");
    await p.change("Source file", "/tmp/edited.py");
    expect(p.host.textContent).not.toContain("a".repeat(64));
    expect(p.button("Submit tested version").disabled).toBe(true);
    noProcessCommands(p.calls);
  });

  it("marks failed status stale, keeps the checked snapshot, and recovers without inventing active state", async () => {
    const p = await mount({ thread: true });
    p.fail("Status service unavailable");
    await p.click("Refresh / adopt");
    expect(p.host.textContent).toMatch(/stale/i);
    expect(p.host.textContent).toContain("2026-09-10T10:00:00Z");
    expect(p.host.textContent).toContain("Status service unavailable");
    expect(p.host.textContent).toContain("pending");
    expect(p.toast).toHaveBeenCalledWith(expect.stringContaining("Status service unavailable"), "error");
    p.fail("");
    p.status({ ...pending, phase: "active", activeVersionId: "new" });
    await p.click("Refresh / adopt");
    expect(p.host.textContent).not.toMatch(/stale/i);
    expect(p.host.textContent).toMatch(/Active.*new.py/);
  });

  it("drops a test result after a file edit, and drops old persona status after a persona switch", async () => {
    const p = await mount({ fleet: [] });
    await p.click("Launch");
    await p.change("Source file", "/tmp/old.py");
    let finishTest!: (receipt: typeof p.receipt) => void;
    p.deferTest(() => new Promise(resolve => { finishTest = resolve; }));
    await p.click("Test");
    await p.change("Source file", "/tmp/changed.py");
    await act(async () => finishTest(p.receipt));
    expect(p.host.textContent).not.toContain(p.receipt.sha256);
    expect(p.button("Submit tested version").disabled).toBe(true);

    let finishStatus!: (status: SubmissionStatus) => void;
    p.deferStatus(() => new Promise(resolve => { finishStatus = resolve; }));
    await p.click("Refresh / adopt");
    p.deferStatus(undefined);
    p.status({ ...pending, hotkey: "other-hotkey", phase: "not-submitted", versions: [], activeVersionId: undefined });
    await p.change("Submission persona", "other");
    await act(async () => finishStatus({ ...pending, detail: "OLD PERSONA RESULT" }));
    expect(p.host.textContent).not.toContain("OLD PERSONA RESULT");
    expect(p.host.textContent).toContain("not-submitted");
    expect(p.host.textContent).not.toContain("old.py");
    expect(p.button("Submit tested version").disabled).toBe(true);
    noProcessCommands(p.calls);
  });

  it("invalidates a previous receipt when a new test fails and never polls during an upload confirmation", async () => {
    vi.useFakeTimers();
    const p = await mount({ thread: true });
    await p.change("Source file", "/tmp/candidate.py");
    await p.click("Test");
    p.fail("Docker is not installed");
    await p.click("Test");
    expect(p.host.textContent).toContain("Docker is not installed");
    expect(p.host.textContent).not.toContain(p.receipt.sha256);
    expect(p.button("Submit tested version").disabled).toBe(true);
    p.fail("");
    await p.click("Test");
    await p.click("Submit tested version");
    const calls = p.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(p.calls).toHaveLength(calls);
    await p.click("Cancel");
    expect(p.calls.some(args => args[1] === "submit")).toBe(false);
  });

  it("uses describe mode when cached catalog metadata is absent", async () => {
    const p = await mount({ fleet: [], cachedSubmission: false, refreshedSubmission: false });
    await p.click("Launch");
    expect(p.host.textContent).toContain("Submission miner");
    noProcessCommands(p.calls);
  });

  it("uses fresh fleet mode before mounting any process thread controls", async () => {
    const process = { ...entry(), mode: undefined, submission: undefined, desired: "running" as const };
    const p = await mount({ thread: true, fleet: [process], liveFleet: [entry()] });
    expect(p.host.textContent).toContain("Submission miner");
    noProcessCommands(p.calls);
  });
});
