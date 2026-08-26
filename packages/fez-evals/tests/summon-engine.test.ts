import { describe, it, expect, vi, beforeEach } from "vitest";
import { SummonEngine, type SummonHost, type SummonEvent } from "../../../src/agent/summon.js";

const OWNER = "aa".repeat(32);
const SIBLING = "bb".repeat(32);
const STRANGER = "cc".repeat(32);
const SCOUT_PK = "dd".repeat(32);

function makeHost(over: Partial<SummonHost> = {}) {
  const spawned: { persona: string; channels: string[]; work?: unknown }[] = [];
  const published: { kind: number; tags: string[][]; content: string }[] = [];
  const host: SummonHost = {
    ownerPubkey: OWNER,
    personaExists: (n) => ["scout", "vault"].includes(n),
    personaPubkey: async (n) => (n === "scout" ? SCOUT_PK : undefined),
    agentAlive: () => false,
    registryEntry: () => undefined,
    spawn: async (persona, channels, work) => { spawned.push({ persona, channels, work }); },
    restart: async (persona, channels, work) => { spawned.push({ persona, channels, work }); },
    query: async () => [],
    publish: async (t) => { published.push(t); },
    announceTimeout: () => {},
    ...over,
  };
  return { host, spawned, published };
}

const msg = (pubkey: string, content: string, extra: string[][] = []): SummonEvent => ({
  kind: 47103, pubkey, content, tags: [["h", "chan1"], ...extra],
});

describe("SummonEngine — channel messages", () => {
  beforeEach(() => vi.useRealTimers());

  it("owner mention of an existing persona spawns it into the channel", async () => {
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "hey @scout look at this"));
    expect(spawned).toEqual([{ persona: "scout", channels: ["chan1"], work: undefined }]);
  });

  it("stranger mentions never summon; attested siblings do", async () => {
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(STRANGER, "@scout go"));
    expect(spawned).toHaveLength(0);
    engine.noteAttestation(SIBLING);
    await engine.handleEvent(msg(SIBLING, "@scout go"));
    expect(spawned).toHaveLength(1);
  });

  it("depth >= 5 never summons", async () => {
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@scout go", [["depth", "5"]]));
    expect(spawned).toHaveLength(0);
  });

  it("unknown personas and code-fenced mentions are ignored", async () => {
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@nobody and `@scout` in backticks"));
    expect(spawned).toHaveLength(0);
  });

  it("an agent's own message never summons it (self-summon guard)", async () => {
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(SCOUT_PK, "@scout failed to start"));
    expect(spawned).toHaveLength(0);
  });

  it("cooldown suppresses a re-summon inside the window", async () => {
    vi.useFakeTimers();
    // agentAlive stays false (the first spawn 'died'): only the cooldown
    // stands between the two mentions.
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host, { cooldownMs: 15_000 });
    await engine.handleEvent(msg(OWNER, "@scout go"));
    await engine.handleEvent(msg(OWNER, "@scout go again"));
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(16_000);
    await engine.handleEvent(msg(OWNER, "@scout third time"));
    expect(spawned).toHaveLength(2);
    vi.useRealTimers();
  });

  it("a message with no h tag never summons", async () => {
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleEvent({ kind: 47103, pubkey: OWNER, content: "@scout", tags: [] });
    expect(spawned).toHaveLength(0);
  });
});
