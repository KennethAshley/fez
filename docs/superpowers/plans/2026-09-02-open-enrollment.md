# Open Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any agent that publishes a signed 47041 binding gets collected and judged; the contest is bounded by random cohort sampling and a per-npub daily limit; the desktop roster shows enrollment.

**Architecture:** Three pure modules (binding parse, roster build, cohort sample + rate ledger) wired into the validator's round loop; the miner publishes its binding on the announce heartbeat; the bazaar extension's roster row reads bindings. fleet.json stays as the seed roster and the uid map for weights.

**Tech Stack:** TypeScript, bun test, nostr-tools. Repo: `~/Projects/Fez/fez-bazaar` (all tasks). Branch: `open-enrollment`.

**Spec:** `/Users/ken/Projects/Fez/fez/docs/superpowers/specs/2026-09-02-open-enrollment-design.md`

## Global Constraints

- Commit messages: plain, no Co-Authored-By/Claude-Session trailers.
- Commit locally only — do NOT `git push`.
- Test runner: `~/.bun/bin/bun test` (no vitest, no new deps/config/lockfiles).
- `npx tsc --noEmit` must stay clean (export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH").
- **Ruling (amends spec):** duplicate-hotkey claimants are EXCLUDED from the roster, not zero-scored — without reverse chain-commitment verification, zero-scoring lets an attacker poison a victim by binding the victim's hotkey. Exclusion is the v1 rule; the spec's "both score zero" waits for phase-2 verification.
- Cohort max default 8 (`BAZAAR_COHORT_MAX`); per-npub daily scored cap default 24 (`BAZAAR_SCORED_PER_DAY`).
- Seed fleet (fleet.json pubkeys) is always bound and is the only source of uids for weights.

---

### Task 1: Binding events — template and parse (kinds.ts)

**Files:**
- Modify: `src/protocol/kinds.ts`
- Test: `test/kinds.test.ts`

**Interfaces:**
- Produces: `bindingTemplate(opts: {netuid: string; hotkey?: string; client?: string; retired?: boolean}): EventTemplate` (kind `KINDS.BINDING`, empty content, tags per spec); `ParsedBinding {id, pubkey, netuid, hotkey?, retired, createdAt}`; `parseBinding(ev: IncomingEvent): ParsedBinding | null` (null when no netuid tag).

- [ ] **Step 1: Failing tests** — append to `test/kinds.test.ts` (bun:test style, fixtures include `kind`):

```ts
describe("binding (47041)", () => {
  it("template carries netuid and optional hotkey/client/retired", () => {
    const t = bindingTemplate({ netuid: "553", hotkey: "5D9x", client: "fez-bazaar-miner/0.2" });
    expect(t.kind).toBe(KINDS.BINDING);
    expect(t.tags).toContainEqual(["netuid", "553"]);
    expect(t.tags).toContainEqual(["hotkey", "5D9x"]);
    expect(t.tags).toContainEqual(["client", "fez-bazaar-miner/0.2"]);
    expect(bindingTemplate({ netuid: "553", retired: true }).tags).toContainEqual(["retired"]);
  });
  it("parses a binding; rejects one with no netuid", () => {
    const ev = { id: "b1", pubkey: "pk", kind: KINDS.BINDING, created_at: 100, content: "",
      tags: [["netuid", "553"], ["hotkey", "5D9x"]] };
    expect(parseBinding(ev)).toEqual({ id: "b1", pubkey: "pk", netuid: "553", hotkey: "5D9x", retired: false, createdAt: 100 });
    expect(parseBinding({ ...ev, tags: [] })).toBeNull();
  });
  it("retired tag parses", () => {
    const ev = { id: "b2", pubkey: "pk", kind: KINDS.BINDING, created_at: 101, content: "",
      tags: [["netuid", "553"], ["retired"]] };
    expect(parseBinding(ev)!.retired).toBe(true);
    expect(parseBinding(ev)!.hotkey).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** — `~/.bun/bin/bun test test/kinds.test.ts` → FAIL (not exported).
- [ ] **Step 3: Implement** in `kinds.ts` (mirror taskTemplate's shape):

```ts
export function bindingTemplate(opts: { netuid: string; hotkey?: string; client?: string; retired?: boolean }): EventTemplate {
  const tags: Tag[] = [["netuid", opts.netuid]];
  if (opts.hotkey) tags.push(["hotkey", opts.hotkey]);
  if (opts.client) tags.push(["client", opts.client]);
  if (opts.retired) tags.push(["retired"]);
  return { kind: KINDS.BINDING, content: "", tags };
}

export interface ParsedBinding {
  id: string;
  pubkey: string;
  netuid: string;
  hotkey?: string;
  retired: boolean;
  createdAt: number;
}

/** 47041 — the enrollment act: this npub asks to be judged. Netuid is the
 * one required claim; a hotkey is optional in v1 (scored ≠ paid). */
export function parseBinding(ev: IncomingEvent): ParsedBinding | null {
  const netuid = tag(ev.tags, "netuid");
  if (!netuid) return null;
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    netuid,
    hotkey: tag(ev.tags, "hotkey"),
    retired: ev.tags.some((t) => t[0] === "retired"),
    createdAt: ev.created_at,
  };
}
```

(`tag()` already exists in kinds.ts — reuse it.)
- [ ] **Step 4: Run** — green (`bun test test/kinds.test.ts`).
- [ ] **Step 5: Commit** — `git commit -am "binding events — 47041 template and parse: the enrollment act"`

---

### Task 2: Roster — latest-wins, retire, duplicate-hotkey exclusion (new module)

**Files:**
- Create: `src/validator/roster.ts`
- Test: `test/roster.test.ts`

**Interfaces:**
- Consumes: `ParsedBinding` from Task 1.
- Produces: `buildRoster(bindings: ParsedBinding[], seed: string[]): Roster` where `Roster = { bound: Set<string>; excluded: { pubkey: string; reason: string }[] }`.

- [ ] **Step 1: Failing tests** — `test/roster.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { buildRoster } from "../src/validator/roster.ts";

const b = (pubkey: string, over: Record<string, unknown> = {}) =>
  ({ id: `${pubkey}-${(over.createdAt as number) ?? 1}`, pubkey, netuid: "553", retired: false, createdAt: 1, ...over }) as never;

describe("buildRoster", () => {
  it("binds enrollees and always binds the seed", () => {
    const r = buildRoster([b("a")], ["s1"]);
    expect(r.bound.has("a")).toBe(true);
    expect(r.bound.has("s1")).toBe(true);
  });
  it("latest binding per npub wins — a retire after a bind unbinds", () => {
    const r = buildRoster([b("a", { createdAt: 1 }), b("a", { createdAt: 2, retired: true })], []);
    expect(r.bound.has("a")).toBe(false);
    expect(r.excluded).toContainEqual({ pubkey: "a", reason: "retired" });
  });
  it("a re-bind after a retire re-enrolls", () => {
    const r = buildRoster([b("a", { createdAt: 2, retired: true }), b("a", { createdAt: 3 })], []);
    expect(r.bound.has("a")).toBe(true);
  });
  it("duplicate hotkey excludes every claimant — poisoning beats zero-scoring", () => {
    const r = buildRoster([b("a", { hotkey: "5D9x" }), b("c", { hotkey: "5D9x", createdAt: 2 })], []);
    expect(r.bound.has("a")).toBe(false);
    expect(r.bound.has("c")).toBe(false);
    expect(r.excluded.filter((e) => e.reason === "duplicate hotkey")).toHaveLength(2);
  });
  it("seed survives even a duplicate-hotkey exclusion", () => {
    const r = buildRoster([b("s1", { hotkey: "h" }), b("x", { hotkey: "h", createdAt: 2 })], ["s1"]);
    expect(r.bound.has("s1")).toBe(true);
    expect(r.bound.has("x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement** — `src/validator/roster.ts`:

```ts
/**
 * Who is in the contest. fleet.json becomes the SEED (always bound — it is
 * also the uid map for weights); everyone else enrolls by 47041. Latest
 * binding per npub wins (replaceable semantics enforced here because a dumb
 * relay may return every version).
 *
 * Duplicate hotkeys EXCLUDE every claimant rather than zero-scoring them:
 * without reverse chain-commitment verification, zero-scoring would let an
 * attacker poison a victim by claiming the victim's hotkey. Exclusion makes
 * the same attack merely annoying. (Spec amended; zero-scoring returns with
 * phase-2 verification.)
 */
import type { ParsedBinding } from "../protocol/kinds.ts";

export interface Roster {
  bound: Set<string>;
  excluded: { pubkey: string; reason: string }[];
}

export function buildRoster(bindings: ParsedBinding[], seed: string[]): Roster {
  const latest = new Map<string, ParsedBinding>();
  for (const bnd of bindings) {
    const cur = latest.get(bnd.pubkey);
    if (!cur || bnd.createdAt > cur.createdAt || (bnd.createdAt === cur.createdAt && bnd.id > cur.id)) {
      latest.set(bnd.pubkey, bnd);
    }
  }
  const byHotkey = new Map<string, string[]>();
  for (const bnd of latest.values()) {
    if (bnd.retired || !bnd.hotkey) continue;
    byHotkey.set(bnd.hotkey, [...(byHotkey.get(bnd.hotkey) ?? []), bnd.pubkey]);
  }
  const dupes = new Set([...byHotkey.values()].filter((pks) => pks.length > 1).flat());

  const bound = new Set<string>(seed);
  const excluded: Roster["excluded"] = [];
  for (const bnd of latest.values()) {
    if (bound.has(bnd.pubkey)) continue; // seed is settled
    if (bnd.retired) { excluded.push({ pubkey: bnd.pubkey, reason: "retired" }); continue; }
    if (dupes.has(bnd.pubkey)) { excluded.push({ pubkey: bnd.pubkey, reason: "duplicate hotkey" }); continue; }
    bound.add(bnd.pubkey);
  }
  // Seed members caught in a dupe still stand, but the OTHER claimants fall.
  for (const pk of dupes) {
    if (bound.has(pk) && !seed.includes(pk)) {
      bound.delete(pk);
      excluded.push({ pubkey: pk, reason: "duplicate hotkey" });
    } else if (!bound.has(pk) && !excluded.some((e) => e.pubkey === pk)) {
      excluded.push({ pubkey: pk, reason: "duplicate hotkey" });
    }
  }
  return { bound, excluded };
}
```

- [ ] **Step 4: Run** — green (all roster tests; check the dupe test expects exactly 2 exclusion rows — dedupe `excluded` if the loop double-adds).
- [ ] **Step 5: Commit** — `git commit -am "roster — enrollment by binding, seed always stands, duplicate hotkeys excluded"`

---

### Task 3: Cohort sampling and the daily ledger (new module)

**Files:**
- Create: `src/validator/cohort.ts`
- Test: `test/cohort.test.ts`

**Interfaces:**
- Consumes: `Branch` (has `minerPk`).
- Produces: `sampleCohort<T extends {minerPk: string}>(branches: T[], max: number, rng: () => number): {selected: T[]; benched: T[]}`; `ScoredLedger` with `admit(pk: string, nowMs: number): boolean` (records on admit) and `perDay` cap from its constructor.

- [ ] **Step 1: Failing tests** — `test/cohort.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { ScoredLedger, sampleCohort } from "../src/validator/cohort.ts";

const br = (pk: string) => ({ minerPk: pk }) as never;

describe("sampleCohort", () => {
  it("under the cap, everyone plays", () => {
    const { selected, benched } = sampleCohort([br("a"), br("b")], 8, () => 0.5);
    expect(selected).toHaveLength(2);
    expect(benched).toHaveLength(0);
  });
  it("over the cap, exactly max selected and the rest benched", () => {
    const branches = "abcdefghij".split("").map(br);
    const { selected, benched } = sampleCohort(branches, 8, () => 0.99);
    expect(selected).toHaveLength(8);
    expect(benched).toHaveLength(2);
  });
  it("selection is rng-driven, not first-come", () => {
    const branches = "abcdefghij".split("").map(br);
    const a = sampleCohort(branches, 3, mulberry(1)).selected.map((x) => (x as { minerPk: string }).minerPk);
    const b = sampleCohort(branches, 3, mulberry(9)).selected.map((x) => (x as { minerPk: string }).minerPk);
    expect(a).not.toEqual(b);
  });
});

function mulberry(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ScoredLedger", () => {
  it("admits up to the daily cap per npub, then refuses", () => {
    const led = new ScoredLedger(2);
    const day = Date.UTC(2026, 8, 2, 12);
    expect(led.admit("a", day)).toBe(true);
    expect(led.admit("a", day)).toBe(true);
    expect(led.admit("a", day)).toBe(false);
    expect(led.admit("b", day)).toBe(true);
  });
  it("a new UTC day resets the count", () => {
    const led = new ScoredLedger(1);
    expect(led.admit("a", Date.UTC(2026, 8, 2, 23))).toBe(true);
    expect(led.admit("a", Date.UTC(2026, 8, 3, 1))).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `src/validator/cohort.ts`:

```ts
/**
 * The O(n²) rail and the grade-farming rail. Sampling is RANDOM among
 * branches received — first-come would hand every oversubscribed round to
 * whoever colocates with the relay. rng is injected so tests are exact.
 *
 * ponytail: the ledger is in-memory — a validator restart forgets the day's
 * counts. Persist to disk if restarts become a farming vector.
 */
export function sampleCohort<T extends { minerPk: string }>(
  branches: T[],
  max: number,
  rng: () => number,
): { selected: T[]; benched: T[] } {
  if (branches.length <= max) return { selected: branches, benched: [] };
  const pool = [...branches];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return { selected: pool.slice(0, max), benched: pool.slice(max) };
}

export class ScoredLedger {
  private counts = new Map<string, number>();
  private day = "";
  constructor(private perDay: number) {}

  admit(pk: string, nowMs: number): boolean {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.counts.clear(); }
    const n = this.counts.get(pk) ?? 0;
    if (n >= this.perDay) return false;
    this.counts.set(pk, n + 1);
    return true;
  }
}
```

- [ ] **Step 4: Run** — green.
- [ ] **Step 5: Commit** — `git commit -am "cohort sampling and the daily ledger — bounded judging, lottery not footrace"`

---

### Task 4: Wire the round loop — bindings in, cohort out (main.ts)

**Files:**
- Modify: `src/validator/main.ts`
- Create: `src/validator/bindings-fetch.ts`
- Test: `test/bindings-fetch.test.ts`

**Interfaces:**
- Consumes: `parseBinding`, `buildRoster`, `sampleCohort`, `ScoredLedger`, existing `collectBranches`, `RelayLike`.
- Produces: `fetchBindings(relay: SubscribeLike, timeoutMs?: number): Promise<ParsedBinding[]>` where `SubscribeLike` matches `RelayLike.subscribe` but its handlers also accept `oneose`.

- [ ] **Step 1: Failing test** — `test/bindings-fetch.test.ts` (fake relay that emits two binding events then EOSE; assert both parsed; assert a non-binding kind is ignored; assert resolution on eose and on timeout with no eose).

```ts
import { describe, expect, it } from "bun:test";
import { fetchBindings } from "../src/validator/bindings-fetch.ts";
import { KINDS } from "../src/protocol/kinds.ts";

const bindingEv = (pubkey: string) => ({
  id: `b-${pubkey}`, pubkey, kind: KINDS.BINDING, created_at: 5, content: "",
  tags: [["netuid", "553"]],
});

describe("fetchBindings", () => {
  it("collects bindings until eose", async () => {
    const relay = {
      subscribe(_f: unknown, handlers: { onevent: (e: never) => void; oneose?: () => void }) {
        handlers.onevent(bindingEv("a") as never);
        handlers.onevent({ ...bindingEv("x"), kind: KINDS.TASK } as never);
        handlers.onevent(bindingEv("b") as never);
        queueMicrotask(() => handlers.oneose?.());
        return { close() {} };
      },
    };
    const got = await fetchBindings(relay as never);
    expect(got.map((g) => g.pubkey)).toEqual(["a", "b"]);
  });
  it("resolves on timeout when the relay never eoses", async () => {
    const relay = { subscribe: () => ({ close() {} }) };
    const got = await fetchBindings(relay as never, 30);
    expect(got).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `src/validator/bindings-fetch.ts`:

```ts
/** One-shot roster read: every 47041 the relay holds, parsed. Resolves on
 * EOSE or the timeout, whichever lands first — a wedged relay costs one
 * roster refresh, never the round. */
import { KINDS, parseBinding, type IncomingEvent, type ParsedBinding } from "../protocol/kinds.ts";

export interface BindingRelay {
  subscribe(
    filters: Record<string, unknown>[],
    handlers: { onevent: (ev: IncomingEvent) => void; oneose?: () => void },
  ): { close(): void };
}

export function fetchBindings(relay: BindingRelay, timeoutMs = 10_000): Promise<ParsedBinding[]> {
  return new Promise((resolve) => {
    const out: ParsedBinding[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub.close();
      resolve(out);
    };
    const sub = relay.subscribe([{ kinds: [KINDS.BINDING] }], {
      onevent: (ev) => {
        if (ev.kind !== KINDS.BINDING) return;
        const b = parseBinding(ev);
        if (b) out.push(b);
      },
      oneose: finish,
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}
```

- [ ] **Step 4: main.ts wiring** (no new tests — pure parts are covered; this is assembly):
  - Add env knobs near the others: `const COHORT_MAX = Number(process.env.BAZAAR_COHORT_MAX ?? 8);` and `const SCORED_PER_DAY = Number(process.env.BAZAAR_SCORED_PER_DAY ?? 24);` and module-level `const ledger = new ScoredLedger(SCORED_PER_DAY);`
  - In `runOnce()`, before posting the task: `const roster = buildRoster(await fetchBindings(relay.current() as never), Object.keys(FLEET));` then `console.log(\`roster: ${roster.bound.size} bound (${roster.bound.size - Object.keys(FLEET).length} enrolled), ${roster.excluded.length} excluded\`);` and log each exclusion (`pubkey.slice(0,8)` + reason).
  - `collectBranches({ ..., authors: [...roster.bound] })`.
  - After collection: `const admitted = branches.filter((b) => ledger.admit(b.minerPk, Date.now()));` — log any refusals as `over daily cap — not scored: <pk8>`. Then `const { selected, benched } = sampleCohort(admitted, COHORT_MAX, Math.random);` — log benched (`benched (oversubscribed round, not judged): <pk8 list>`). Judge and attest `selected` only. **The uid map and weights code stay exactly as-is** (FLEET-only — spec: scored ≠ paid).
- [ ] **Step 5: Full checks** — `~/.bun/bin/bun test` (all green except nothing — theme-tokens is fixed now) and `npx tsc --noEmit` clean.
- [ ] **Step 6: Commit** — `git commit -am "the contest opens — roster from bindings, random cohorts, daily caps; fleet stays the paymaster"`

---

### Task 5: The miner enrolls itself (announce path)

**Files:**
- Modify: `src/miner/main.ts` (in `announce()`, after the 47005 publish)

**Interfaces:**
- Consumes: `bindingTemplate` from Task 1; existing `tryPublish(kind, content, tags, label)`.

- [ ] **Step 1: Implement** — inside `announce()` directly after the capability publish:

```ts
// Enrollment rides the heartbeat: replaceable, so re-announcing is
// re-affirming, and a retired binding is published by whoever owns the key.
const binding = bindingTemplate({
  netuid: process.env.BAZAAR_NETUID ?? "553",
  hotkey: process.env.BAZAAR_HOTKEY,
  client: "fez-bazaar-miner",
});
await tryPublish(binding.kind, binding.content, binding.tags, "binding (47041)");
```

(Match `tryPublish`'s actual signature — read it first; if it takes `(kind, content, tags, label)` as the announce calls suggest, the above is exact.)
- [ ] **Step 2: Checks** — `~/.bun/bin/bun test` green, `npx tsc --noEmit` clean.
- [ ] **Step 3: Commit** — `git commit -am "miners enroll on the heartbeat — the binding rides the announce"`

---

### Task 6: Desktop roster shows enrollment (gui logic)

**Files:**
- Modify: `src/gui/logic.ts`, `src/gui/gui.tsx` (minimal), and wherever `Collected`/row-building ingests relay events (read `logic.ts` top-to-bottom first)
- Test: `test/gui-logic.test.ts`

**Interfaces:**
- Consumes: binding events (kind 47041) among the raw events the panel already collects.
- Produces: `MinerRow.enrolled: boolean`; `statusLine(row)` gains an enrollment clause.

- [ ] **Step 1: Failing tests** — append to `test/gui-logic.test.ts`, mirroring its existing fixture style: a row whose pk has a live (non-retired, latest) binding among the collected events has `enrolled: true`; a pk with no binding has `enrolled: false`; `statusLine` for an un-enrolled running miner contains `"not enrolled"`; for an enrolled one contains `"enrolled"`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — in `logic.ts`: ingest 47041 events into `Collected` (a `bindings: Map<pubkey, {retired, createdAt}>`, latest-wins — reuse the same latest-wins comparison as Task 2, duplicated knowingly: the gui bundle must not import validator code); set `enrolled` on each row; extend `statusLine` with `· enrolled — scored` / `· not enrolled — answers unscored` per the spec's wording. In `gui.tsx`, no layout change — `statusLine` already renders.
- [ ] **Step 4: Run** — green; `npx tsc --noEmit` clean; `bun run build:gui` succeeds.
- [ ] **Step 5: Commit** — `git commit -am "roster rows say whether the judge can see them — enrollment status from bindings"`

---

### Task 7: Gates

- [ ] `~/.bun/bin/bun test` → fully green (theme-tokens included — it was fixed).
- [ ] `npx tsc --noEmit` → clean.
- [ ] `bun run build` → all three binaries compile.
- [ ] Do NOT push, do NOT deploy — Ken tests first.
