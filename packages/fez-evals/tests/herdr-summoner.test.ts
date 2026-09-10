import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FezExtensionAPI, NostrEvent } from "../../fez-herdr/src/api-types.js";

const terminal = vi.hoisted(() => ({ calls: [] as { method: string; params: Record<string, unknown> }[] }));
vi.mock("node:net", () => ({ default: { connect: () => {
  const socket = Object.assign(new EventEmitter(), {
    write(line: string) {
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      terminal.calls.push(request);
      const result = request.method === "tab.create"
        ? { tab: { tab_id: `tab-${terminal.calls.length}` }, root_pane: { pane_id: "pane" } }
        : { tabs: [] };
      queueMicrotask(() => socket.emit("data", Buffer.from(JSON.stringify({ id: request.id, result }) + "\n")));
    },
    end() {},
    destroy() {},
  });
  queueMicrotask(() => socket.emit("connect"));
  return socket;
} } }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execSync: () => { throw new Error("no agent process"); },
}));

const OWNER = "aa".repeat(32);
const MEMBER = "bb".repeat(32);
const STRANGER = "cc".repeat(32);
const SCOUT_KEY = "01".repeat(32);
const SCOUT = getPublicKey(new Uint8Array(32).fill(1));
const VAULT = getPublicKey(new Uint8Array(32).fill(2));
const event = (kind: number, pubkey: string, content = "", tags: string[][] = [], created_at = 100): NostrEvent => ({
  id: String(kind), kind, pubkey, content, tags, created_at, sig: "",
});
const announcement = (pubkey: string) => event(47000, pubkey, JSON.stringify({ name: "scout" }));
const ownerRoster = () => event(47102, OWNER, "", [["d", "roster"], ["p", OWNER, "owner"], ["p", MEMBER, "member"]]);
const foreignRoster = () => event(47102, STRANGER, "", [["d", "roster"], ["p", STRANGER, "admin"]], 200);
let home: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  terminal.calls.length = 0;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-herdr-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("FEZ_HOME", path.join(home, ".fez"));
  vi.stubEnv("FEZ_KEYSTORE", "file");
  fs.mkdirSync(path.join(home, ".fez", "personas"), { recursive: true });
  fs.mkdirSync(path.join(home, ".fez", "agents"));
  for (const name of ["scout", "vault"]) fs.writeFileSync(path.join(home, ".fez", "personas", `${name}.md`), "harness: claude");
  fs.writeFileSync(path.join(home, ".fez", "agents", "scout.key"), SCOUT_KEY);
  fs.writeFileSync(path.join(home, ".fez", "agents", "vault.key"), "02".repeat(32));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

async function start(registered = false) {
  if (registered) fs.writeFileSync(path.join(home, ".fez", "herdr-tabs.json"), JSON.stringify([
    { persona: "scout", channels: ["chan1"], tabId: "tab", paneId: "pane" },
  ]));
  const subscriptions: { kinds: number[]; receive: (event: NostrEvent) => void }[] = [];
  const published: NostrEvent[] = [];
  const state = { rosters: [ownerRoster()], failAttestation: false, beforeRosterPublish: async () => {} };
  const api: FezExtensionAPI = {
    registerCommand() {}, registerInputHandler() {}, registerUrlHandler() {},
    ui: {
      setStatus() {}, createSidePanel: () => ({ setText() {} }),
      appendMessage: () => ({ setAuthor() {}, setContent() {}, setFooter() {} }),
      notify() {}, clearLog() {},
    },
    nostr: {
      pubkey: OWNER,
      subscribe: (filters, receive) => {
        subscriptions.push({ kinds: filters.flatMap((filter) => filter.kinds ?? []), receive });
        return () => {};
      },
      query: async (filters) => filters[0].kinds?.includes(47102) ? state.rosters : [],
      publish: async (template) => {
        if (template.kind === 47006 && state.failAttestation) throw new Error("offline");
        if (template.kind === 47102) await state.beforeRosterPublish();
        const signed = event(template.kind, OWNER, template.content, template.tags, template.created_at);
        if (template.kind === 47102) state.rosters = [signed];
        published.push(signed);
        return signed;
      },
      encrypt: () => { throw new Error("unused"); },
      decrypt: () => { throw new Error("unused"); },
    },
  };
  const { default: herdr } = await import("../../fez-herdr/src/index.js");
  herdr(api);
  const emit = async (value: NostrEvent) => {
    for (const subscription of subscriptions) if (subscription.kinds.includes(value.kind)) subscription.receive(value);
    await vi.advanceTimersByTimeAsync(0);
  };
  await vi.advanceTimersByTimeAsync(0);
  return { emit, published, state };
}

it("a registered persona's display name cannot attest a stranger or authorize its summons", async () => {
  const { emit, published } = await start(true);
  await emit(announcement(STRANGER));
  await emit(event(47103, STRANGER, "@vault go", [["h", "chan1"]]));
  expect(published).toHaveLength(0);
  expect(terminal.calls.filter((call) => call.method === "tab.create")).toHaveLength(0);
});

it("a spoofed announcement cannot relabel a registered agent's terminal status", async () => {
  const { emit } = await start(true);
  await emit(announcement(STRANGER));
  await emit(event(7, STRANGER, "👀"));
  expect(terminal.calls.filter((call) => call.method === "tab.rename")).toHaveLength(0);
  await emit(announcement(SCOUT));
  await emit(event(7, SCOUT, "👀"));
  expect(terminal.calls.filter((call) => call.method === "tab.rename").map((call) => call.params)).toEqual([
    { tab_id: "tab", label: "fez:scout 👀" },
  ]);
});

it("a spoof cannot consume a pending invite; the local key carries the owner's members forward", async () => {
  const { emit, published, state } = await start();
  state.rosters.push(foreignRoster());
  await emit(event(47103, OWNER, "@scout go", [["h", "chan1"]]));
  await emit(announcement(STRANGER));
  expect(published).toHaveLength(0);
  await emit(announcement(SCOUT));
  expect(published.find((item) => item.kind === 47102)?.tags).toEqual([
    ["d", "roster"], ["p", OWNER, "owner"], ["p", MEMBER, "member"], ["p", SCOUT, "bot"],
  ]);
  expect(published.find((item) => item.kind === 47006)?.tags).toEqual([["p", SCOUT]]);
});

it.each([false, true])("invites preserve the canonical roster on timestamp ties (reversed arrival: %s)", async (reversed) => {
  const { emit, published, state } = await start();
  state.rosters = [
    { ...ownerRoster(), id: "00".repeat(32) },
    { ...event(47102, OWNER, "", [["d", "roster"], ["p", OWNER, "owner"], ["p", STRANGER, "member"]]), id: "ff".repeat(32) },
  ];
  if (reversed) state.rosters.reverse();
  await emit(event(47103, OWNER, "@scout go", [["h", "chan1"]]));
  await emit(announcement(SCOUT));
  expect(published.find((item) => item.kind === 47102)?.tags).toEqual([
    ["d", "roster"], ["p", OWNER, "owner"], ["p", MEMBER, "member"], ["p", SCOUT, "bot"],
  ]);
});

it.each([{ rosters: [] }, { rosters: [foreignRoster()] }])("an absent owner roster refuses the write and leaves the invite retryable ($rosters)", async ({ rosters }) => {
  const { emit, published, state } = await start();
  state.rosters = rosters;
  await emit(event(47103, OWNER, "@scout go", [["h", "chan1"]]));
  await emit(announcement(SCOUT));
  expect(published.filter((item) => item.kind === 47102)).toHaveLength(0);
  state.rosters = [ownerRoster()];
  await emit(announcement(SCOUT));
  expect(published.find((item) => item.kind === 47102)?.tags).toContainEqual(["p", SCOUT, "bot"]);
});

it("failed attestation cannot authorize summons and a later valid announcement retries it", async () => {
  const { emit, state } = await start(true);
  state.failAttestation = true;
  await emit(announcement(SCOUT));
  await emit(event(47103, SCOUT, "@vault go", [["h", "chan1"]]));
  expect(terminal.calls.filter((call) => call.method === "tab.create")).toHaveLength(0);
  state.failAttestation = false;
  await emit(announcement(SCOUT));
  await emit(event(47103, SCOUT, "@vault go", [["h", "chan1"]]));
  expect(terminal.calls.filter((call) => call.method === "tab.create")).toHaveLength(1);
});

it.each([false, true])("concurrent announcements preserve roster members and recover from failed writes (first fails: %s)", async (failFirst) => {
  const { emit, state } = await start();
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let writes = 0;
  state.beforeRosterPublish = async () => {
    if (writes++ === 0) {
      await firstWrite;
      if (failFirst) throw new Error("first write failed");
    }
  };
  await emit(event(47103, OWNER, "@scout @vault go", [["h", "chan1"]]));
  await emit(announcement(SCOUT));
  await emit(event(47000, VAULT, JSON.stringify({ name: "vault" })));
  releaseFirst();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.rosters[0].tags).toContainEqual(["p", OWNER, "owner"]);
  expect(state.rosters[0].tags).toContainEqual(["p", MEMBER, "member"]);
  expect(state.rosters[0].tags).toContainEqual(["p", VAULT, "bot"]);
  if (!failFirst) expect(state.rosters[0].tags).toContainEqual(["p", SCOUT, "bot"]);
});

it("a first-spawn announcement waits for the local key without creating a replacement", async () => {
  const keyFile = path.join(home, ".fez", "agents", "scout.key");
  fs.rmSync(keyFile);
  const { emit, published } = await start();
  await emit(event(47103, OWNER, "@scout go", [["h", "chan1"]]));
  await emit(announcement(SCOUT));
  expect(published).toHaveLength(0);
  expect(fs.existsSync(keyFile)).toBe(false);
  fs.writeFileSync(keyFile, SCOUT_KEY);
  await emit(announcement(SCOUT));
  expect(published.find((item) => item.kind === 47102)?.tags).toContainEqual(["p", SCOUT, "bot"]);
});

it("restores the owner while retaining members when the prior owner-signed roster omitted them", async () => {
  const { emit, published, state } = await start();
  state.rosters = [event(47102, OWNER, "", [["d", "roster"], ["p", MEMBER, "member"]])];
  await emit(event(47103, OWNER, "@scout go", [["h", "chan1"]]));
  await emit(announcement(SCOUT));
  expect(published.find((item) => item.kind === 47102)?.tags).toEqual([
    ["d", "roster"], ["p", OWNER, "owner"], ["p", MEMBER, "member"], ["p", SCOUT, "bot"],
  ]);
});

it("DM wakeups match local keys rather than metadata names", async () => {
  const { emit } = await start();
  await vi.advanceTimersByTimeAsync(5001);
  await emit(announcement(STRANGER));
  await emit(event(1059, OWNER, "", [["p", STRANGER]]));
  expect(terminal.calls.filter((call) => call.method === "tab.create")).toHaveLength(0);
  await emit(announcement(SCOUT));
  await emit(event(1059, OWNER, "", [["p", SCOUT]]));
  expect(terminal.calls.filter((call) => call.method === "tab.create")).toHaveLength(1);
});
