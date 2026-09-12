import { afterEach, expect, it, vi } from "vitest";
import type { Wire, WireEvent } from "../../fez-client/src/index.js";
import { startSummoner } from "../../fez-desktop/src/summoner.js";

const native = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>());
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({ invoke: native }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); native.mockReset(); });

const OWNER = "aa".repeat(32);
const SCOUT = "bb".repeat(32);
const STRANGER = "cc".repeat(32);
const event = (kind: number, pubkey: string, content = "", tags: string[][] = []): WireEvent => ({
  id: String(kind), kind, pubkey, content, tags, created_at: 100, sig: "",
});

it("prepares native ownership before subscribing, retries failures once per 30s, and cleans up", async () => {
  vi.useFakeTimers();
  let ready = false;
  const toast = vi.fn();
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() => unsubscribe);
  const wire = { subscribe, query: async () => [] } as unknown as Wire;
  native.mockImplementation(async (command) => {
    expect(command).toBe("start_desktop_runtime");
    if (!ready) throw new Error("background worker unavailable");
    return { background: true, restored: 2 };
  });
  const stop = startSummoner({ wire, ownerPubkey: OWNER, relays: ["wss://example.test"], toast });
  try {
    expect(subscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(native).toHaveBeenCalledWith("start_desktop_runtime", { owner: OWNER, relays: "wss://example.test" });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("background worker unavailable"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(subscribe).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    ready = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(subscribe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(native).toHaveBeenCalledTimes(4);
  } finally { stop(); }
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(native).toHaveBeenCalledTimes(4);
});

it("does not subscribe after disposal while native startup is pending", async () => {
  vi.useFakeTimers();
  let ready!: () => void;
  native.mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
  const subscribe = vi.fn(() => () => {});
  const stop = startSummoner({ wire: { subscribe, query: async () => [] } as unknown as Wire, ownerPubkey: OWNER, relays: [], toast: vi.fn() });
  stop();
  ready();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(subscribe).not.toHaveBeenCalled();
  expect(native).toHaveBeenCalledTimes(1);
});

it.each([true, false])("uses the native persona public key, including first spawn (key already exists: %s)", async (keyExists) => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  let keyReady = keyExists;
  native.mockImplementation(async (command, args) => {
    switch (command) {
      case "start_desktop_runtime": return { background: true, restored: 0 };
      case "runner_status": return true; // A legacy PID must never defer desktop summons.
      case "agent_alive": return args?.bin !== "fez-agent";
      case "list_personas": return ["scout"];
      case "read_persona": return "harness: claude";
      case "spawned_agents": return [];
      case "get_pubkey":
        if (args?.account !== "agent:scout" || !keyReady) throw new Error("no fez identity");
        return SCOUT;
      case "spawn_agent": keyReady = true; return;
      default: throw new Error(`unexpected native command: ${command}`);
    }
  });
  const subscriptions: { kinds: number[]; receive: (event: WireEvent) => void }[] = [];
  const published: WireEvent[] = [];
  const wire: Wire = {
    pubkey: OWNER,
    subscribe: (filters, receive) => {
      subscriptions.push({ kinds: filters.flatMap((filter) => filter.kinds ?? []), receive });
      return () => {};
    },
    query: async (filters) => {
      if (filters[0].kinds?.includes(47000)) return [event(47000, STRANGER, JSON.stringify({ name: "scout" }))];
      if (filters[0].kinds?.includes(47102)) return [event(47102, OWNER, "", [["d", "roster"], ["p", OWNER, "owner"]])];
      return [];
    },
    publish: async (template) => {
      const signed = event(template.kind, OWNER, template.content, template.tags);
      published.push(signed);
      return signed;
    },
    encrypt: () => { throw new Error("unused"); },
    decrypt: () => { throw new Error("unused"); },
    sendDm: async () => { throw new Error("unused"); },
    unwrapDm: () => undefined,
  };
  const emit = async (value: WireEvent) => {
    for (const subscription of subscriptions) if (subscription.kinds.includes(value.kind)) subscription.receive(value);
    await vi.advanceTimersByTimeAsync(0);
  };
  const stop = startSummoner({ wire, ownerPubkey: OWNER, relays: ["wss://example.test"], toast: () => {} });
  try {
    await vi.advanceTimersByTimeAsync(0); // Native runtime is ready before live subscriptions.
    await emit(event(20001, STRANGER)); // A spoofed name + presence must not suppress the real agent.
    await emit(event(47103, OWNER, "@scout go", [["h", "chan1"]]));
    expect(native).toHaveBeenCalledWith("spawn_agent", expect.objectContaining({ persona: "scout", channels: ["chan1"] }));
    expect(native.mock.calls.some(([command]) => command === "runner_status")).toBe(false);
    expect(native.mock.calls.find(([command]) => command === "spawn_agent")?.[1]?.manual).toBeUndefined();
    expect(native).toHaveBeenCalledWith("get_pubkey", { account: "agent:scout" });
    expect(published.filter((item) => item.kind === 47102)).toHaveLength(keyExists ? 1 : 0);

    await emit(event(47000, STRANGER, JSON.stringify({ name: "scout" })));
    await emit(event(47000, SCOUT, JSON.stringify({ name: "scout" })));
    expect(published.filter((item) => item.kind === 47102).flatMap((item) => item.tags)).toContainEqual(["p", SCOUT, "bot"]);
    expect(published.flatMap((item) => item.tags).some((tag) => tag[1] === STRANGER)).toBe(false);
    expect(native.mock.calls.some(([command]) => command === "get_identity")).toBe(false);
  } finally {
    stop();
  }
});

it("restarts with the channel union and existing work context in one native call", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  native.mockImplementation(async (command) => {
    switch (command) {
      case "start_desktop_runtime": return { background: true, restored: 0 };
      case "runner_status": return false;
      case "agent_alive": return true;
      case "list_personas": return ["scout"];
      case "read_persona": return "harness: claude";
      case "get_pubkey": return SCOUT;
      case "spawned_agents": return [{ persona: "scout", bin: "fez-miner", channels: [] }, { persona: "scout", channels: ["first"], repo: "project", line: "main" }];
      case "kill_agent": case "spawn_agent": return 42;
      default: throw new Error(`unexpected native command: ${command}`);
    }
  });
  const subscriptions: ((event: WireEvent) => void)[] = [];
  const wire = { pubkey: OWNER, query: async () => [], subscribe: (_filters: unknown, receive: (event: WireEvent) => void) => {
    subscriptions.push(receive); return () => {};
  } } as unknown as Wire;
  const stop = startSummoner({ wire, ownerPubkey: OWNER, relays: ["wss://example.test"], toast: vi.fn() });
  try {
    await vi.advanceTimersByTimeAsync(0);
    for (const receive of subscriptions) receive(event(47103, OWNER, "@scout go", [["h", "second"]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(native).toHaveBeenCalledWith("spawn_agent", {
      persona: "scout", channels: ["first", "second"], repo: "project", baseBranch: "main",
      owner: OWNER, relays: "wss://example.test", manual: true,
    });
    expect(native.mock.calls.some(([command]) => command === "kill_agent")).toBe(false);
  } finally { stop(); }
});
