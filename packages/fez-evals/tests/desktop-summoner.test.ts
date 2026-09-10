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

it.each([true, false])("uses the native persona public key, including first spawn (key already exists: %s)", async (keyExists) => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  let keyReady = keyExists;
  native.mockImplementation(async (command, args) => {
    switch (command) {
      case "runner_status": case "agent_alive": return false;
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
    await emit(event(20001, STRANGER)); // A spoofed name + presence must not suppress the real agent.
    await emit(event(47103, OWNER, "@scout go", [["h", "chan1"]]));
    expect(native).toHaveBeenCalledWith("spawn_agent", expect.objectContaining({ persona: "scout", channels: ["chan1"] }));
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
