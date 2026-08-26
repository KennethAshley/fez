# Relay-Fired Schedules (Sealed Intents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduled messages fire from the relay — signed at schedule time, sealed inside the 40006 intent, released by a relay-side executor at `send_at` — so they deliver whether or not any client machine is awake; reminders fire in the open desktop app.

**Architecture:** The client signs the *final* 47103 at schedule time (`created_at = send_at`) and embeds it in the 40006's content (a "sealed intent"). The relay gains two extension-seam capabilities — `onEvent` (observe accepted events) and `inject` (run an event through the normal ingest pipeline) — and a scheduler module, on by default, that arms sealed intents and injects the embedded event at fire time. The executor authors nothing: the embedded event carries the author's own signature, and re-injection is idempotent because relays dedupe by event id. The sentinel learns the sealed format (and keeps firing legacy plaintext intents); the desktop fires reminders itself while open.

**Tech Stack:** TypeScript throughout — fez-relay (node, `ws` + `nostr-tools`), `@fezchat/protocol` (shared sealed-intent codec), fez-client + desktop webview, fez-sentinel. Tests: vitest in `packages/fez-evals/tests`.

**Spec:** `docs/superpowers/specs/2026-08-25-gui-desentinel-design.md` (workstream 3)

## Global Constraints

- Work in a fresh worktree branched from main (`git worktree add ../fez-scheduler-wt -b relay-scheduler`). Never commit `src/agent/harness.ts` (Ken's WIP lives on main's tree, not the worktree, but keep the rule).
- **The relay executor never signs user content** (spec: "the executor may sign *its own* bookkeeping, never user content"). In this design it signs nothing at all.
- **The relay scheduler handles SEALED intents only.** Legacy plaintext 40006s remain the sentinel's job — the relay cannot sign as the author, and splitting ownership this way means the two executors can never double-deliver (sealed release is idempotent by embedded event id; legacy is sentinel-only).
- Sealed embedded events are **plaintext in the queue** — a deliberate spec correction: the spec's "optionally NIP-44'd to the author" is unimplementable (an executor with no keys could not read it to release it), and the content becomes public at `send_at` anyway. Workspace members who query 40006s see pending text early — exactly as they do with today's legacy plaintext form.
- Discovered pre-existing bug, fixed in Task 5: sentinel `fireIntent` requires both `h` and `c` tags but `scheduleMessage` only ever set `h` — legacy scheduled messages never fired. The `c` (community) tag is retired (flat workspaces); the fix drops the `c` requirement.
- Commits: plain messages, NO Claude co-author/session trailers.
- Test commands: `cd packages/fez-evals && npx vitest --run tests/<file>`; relay package builds with `cd packages/fez-relay && npm run build` (tsc); sentinel with `cd packages/fez-sentinel && npm run build`; desktop typecheck `cd packages/fez-desktop && npx tsc --noEmit`.
- Timer arithmetic mirrors the sentinel: `delayMs = Math.min(Math.max(0, at*1000 - Date.now()), 2**31 - 1)`; overdue intents fire immediately on arm.

---

### Task 1: Sealed-intent codec in `@fezchat/protocol`

**Files:**
- Create: `src/protocol/intents.ts`
- Modify: `src/index.ts` (export line)
- Modify: `src/protocol/kinds.ts:` the `KIND_SCHEDULED`/`KIND_REMINDER` doc comment (~line 293-300)
- Test: `packages/fez-evals/tests/sealed-intents.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 3, 4, 5 rely on):
  - `interface SealedEvent { id: string; kind: number; pubkey: string; content: string; tags: string[][]; created_at: number; sig: string }`
  - `sealContent(event: SealedEvent): string` — the 40006 content wrapping a signed event.
  - `parseSealed(content: string): SealedEvent | undefined` — undefined for legacy plaintext or malformed JSON; validates the embedded shape (all seven fields present, correct types) without verifying the signature (the relay ingest pipeline does that).

- [ ] **Step 1: Write the failing test**

`packages/fez-evals/tests/sealed-intents.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { sealContent, parseSealed } from "../../../src/protocol/intents.js";

const sk = generateSecretKey();
const signed = finalizeEvent(
  { kind: 47103, created_at: 1_900_000_000, tags: [["h", "chan1"]], content: "future words" },
  sk
);

describe("sealed intents", () => {
  it("round-trips a signed event", () => {
    const sealed = parseSealed(sealContent(signed));
    expect(sealed).toEqual(signed);
  });

  it("legacy plaintext content parses as undefined", () => {
    expect(parseSealed("remember the milk")).toBeUndefined();
    expect(parseSealed("")).toBeUndefined();
  });

  it("malformed or incomplete sealed payloads parse as undefined", () => {
    expect(parseSealed(JSON.stringify({ sealed: { kind: 47103 } }))).toBeUndefined();
    expect(parseSealed(JSON.stringify({ other: 1 }))).toBeUndefined();
    expect(parseSealed(JSON.stringify({ sealed: null }))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-evals && npx vitest --run tests/sealed-intents.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `src/protocol/intents.ts`**

```ts
/**
 * Sealed schedule intents (de-sentinel workstream 3).
 *
 * A scheduled message is signed by its author AT SCHEDULE TIME with
 * created_at = send_at, then embedded whole inside the 40006 intent's
 * content. Whoever executes the intent — the relay's scheduler, the
 * sentinel — merely RELEASES the embedded, already-signed event at the
 * appointed time. The executor authors nothing, holds no keys, and
 * re-release is idempotent (relays dedupe by event id).
 *
 * The queue is plaintext on purpose: an executor without keys could not
 * decrypt a sealed payload to release it, and the content becomes public
 * at send_at regardless.
 */

export interface SealedEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  created_at: number;
  sig: string;
}

export function sealContent(event: SealedEvent): string {
  return JSON.stringify({ sealed: event });
}

export function parseSealed(content: string): SealedEvent | undefined {
  try {
    const parsed = JSON.parse(content) as { sealed?: unknown };
    const e = parsed?.sealed as Partial<SealedEvent> | null | undefined;
    if (
      !e ||
      typeof e.id !== "string" ||
      typeof e.kind !== "number" ||
      typeof e.pubkey !== "string" ||
      typeof e.content !== "string" ||
      !Array.isArray(e.tags) ||
      typeof e.created_at !== "number" ||
      typeof e.sig !== "string"
    ) {
      return undefined;
    }
    return e as SealedEvent;
  } catch {
    return undefined;
  }
}
```

In `src/index.ts`, next to the dm.js export (~line 70):

```ts
export { sealContent, parseSealed, type SealedEvent } from "./protocol/intents.js";
```

In `src/protocol/kinds.ts`, extend the 40006/40007 comment block (keep the existing text, append):

```
 * 40006 content is either legacy plaintext (the message text; sentinel-
 * fired) or a SEALED intent: JSON {sealed: <full signed 47103 with
 * created_at = send_at>} released verbatim by the relay scheduler or the
 * sentinel at fire time — see src/protocol/intents.ts.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fez-evals && npx vitest --run tests/sealed-intents.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/intents.ts src/index.ts src/protocol/kinds.ts packages/fez-evals/tests/sealed-intents.test.ts
git commit -m "protocol: sealed schedule intents — sign at schedule time, release at send_at"
```

---

### Task 2: Relay seam — `onEvent` observers + `inject`

**Files:**
- Modify: `packages/fez-relay/src/relay.ts` (extract ingest pipeline; add observer/inject surface)
- Modify: `packages/fez-relay/src/extensions.ts` (API + LoadOptions additions)
- Test: `packages/fez-evals/tests/relay-inject.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 3 relies on):
  - On `RelayExtensionAPI` and `LoadOptions`: `onEvent(cb: (event: StoredEvent) => void): void` — cb runs for every ACCEPTED event (stored and ephemeral) after fan-out; `inject(event: StoredEvent): { accepted: boolean; reason?: string }` — runs the full ingest pipeline (size caps where applicable, duplicate-id check, signature verification, policy pipeline, store, fan-out, observer notification). A duplicate returns `{ accepted: false, reason: "duplicate:" }`-style rejection exactly as a live EVENT would.
  - On the relay handle that `cli.ts` holds (whatever `relay.ts` exports as its server object): the same `onEvent`/`inject` methods, so a built-in module can use them without going through the extension loader.

- [ ] **Step 1: Write the failing test**

Model the harness on an existing relay test — read `packages/fez-evals/tests/membership-relay.test.ts` FIRST and reuse its start/connect helpers (the relay tests there already start a real relay in-process; mirror that setup exactly rather than inventing one). The test content:

```ts
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
// + the same relay-construction imports/helpers membership-relay.test.ts uses

const sk = generateSecretKey();
const ev = (content: string, createdAt: number) =>
  finalizeEvent({ kind: 47103, created_at: createdAt, tags: [["h", "chan1"]], content }, sk);

describe("relay inject + observers", () => {
  it("inject runs the full pipeline: stores, fans out, notifies observers", async () => {
    // start relay (per existing helper); subscribe a ws client to kinds [47103]
    // register an observer via relay.onEvent(cb)
    const e = ev("released", Math.floor(Date.now() / 1000));
    const verdict = relay.inject(e);
    expect(verdict.accepted).toBe(true);
    // observer saw it; ws subscriber received ["EVENT", subId, e]; relay.query returns it
  });

  it("inject of a duplicate id is rejected, not double-stored", async () => {
    const e = ev("once", Math.floor(Date.now() / 1000));
    expect(relay.inject(e).accepted).toBe(true);
    expect(relay.inject(e).accepted).toBe(false);
    // query returns exactly one copy
  });

  it("inject verifies signatures — a tampered event is refused", async () => {
    const e = { ...ev("real", Math.floor(Date.now() / 1000)), content: "forged" };
    expect(relay.inject(e).accepted).toBe(false);
  });

  it("observers also see events arriving over the wire", async () => {
    // publish a normal EVENT via the ws client; observer cb fires with it
  });
});
```

(The comment lines are instructions to the implementer: fill them with the concrete helper calls the existing relay tests use. The assertions shown are the required ones.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-evals && npx vitest --run tests/relay-inject.test.ts` — FAIL (no `inject` on the relay).

- [ ] **Step 3: Implement the seam**

In `packages/fez-relay/src/relay.ts` — the current EVENT handling is inline in the ws message handler (`msg[0] === "EVENT"` branch, ~line 411-470: caps → duplicate check → `verifyEvent` → policy loop → store/fan-out). Refactor with the existing code as the oracle:

1. Extract the post-parse pipeline into a method `ingest(event: StoredEvent, ctx: { via: "wire" | "inject" }): { accepted: boolean; reason?: string }` containing, verbatim-moved: duplicate-id check, signature verification (respecting the existing verify-disable option), the policy pipeline (first reject wins), deletion masking (NIP-09 branch), store append for non-ephemeral kinds, fan-out to matching subscriptions. The ws branch keeps: frame/size caps (wire concern), the `["OK", id, accepted, reason]` reply, and NIP-20 semantics — it now calls `ingest(event, { via: "wire" })` and replies from the verdict.
2. Add `private observers: ((event: StoredEvent) => void)[] = []` and public `onEvent(cb)` / `inject(event)` on the relay class. `ingest` notifies every observer (inside try/catch — a throwing observer must never break ingest) after successful accept. `inject` simply returns `ingest(event, { via: "inject" })`.
3. In `packages/fez-relay/src/extensions.ts`: add to `RelayExtensionAPI` and `LoadOptions`:

```ts
  /** Observe every accepted event (stored + ephemeral), after fan-out. */
  onEvent(cb: (event: StoredEvent) => void): void;
  /**
   * Feed an event through the relay's normal ingest pipeline — dedupe,
   * signature verification, policies, store, fan-out — exactly as if it
   * arrived over the wire. The relay stays the validator; injection
   * grants no authority a signed event doesn't already carry.
   */
  inject(event: StoredEvent): { accepted: boolean; reason?: string };
```

and thread them through `loadRelayExtensions` (`onEvent: opts.onEvent`, `inject: opts.inject`) the way `query` already is. Update the `cli.ts` call site that builds `LoadOptions` to pass the relay's new methods.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-evals && npx vitest --run tests/relay-inject.test.ts` — PASS. Also re-run the existing relay tests (`npx vitest --run tests/membership-relay.test.ts` and any other `*relay*.test.ts`) — the pipeline extraction must not change wire behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-relay/src/relay.ts packages/fez-relay/src/extensions.ts packages/fez-relay/src/cli.ts packages/fez-evals/tests/relay-inject.test.ts
git commit -m "relay: onEvent observers + inject through the ingest pipeline (extension seam)"
```

---

### Task 3: The scheduler module

**Files:**
- Create: `packages/fez-relay/src/scheduler.ts`
- Modify: `packages/fez-relay/src/cli.ts` (activate by default; `--no-scheduler` flag; help text)
- Test: `packages/fez-evals/tests/relay-scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseSealed`; Task 2's `onEvent`/`inject`/`query` surface.
- Produces: `activateScheduler(api: SchedulerApi): void` where `interface SchedulerApi { query(filter: Record<string, unknown>): StoredEvent[]; onEvent(cb: (event: StoredEvent) => void): void; inject(event: StoredEvent): { accepted: boolean; reason?: string }; log(line: string): void }` — deliberately the subset of `RelayExtensionAPI` it needs, so it can later ship as a standalone relay extension unchanged.
- Packaging ruling (documented deviation from the spec's letter): the scheduler ships INSIDE fez-relay, activated by default (`--no-scheduler` to disable), but written against the extension API subset. The spec said "shipped as a relay extension"; default-on for the desktop's local relay is the spec's intent, and the desktop spawns the relay without `--extensions` — building it in (API-shaped) delivers default-on with zero new install machinery while staying one `mv` away from extension packaging.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { sealContent } from "../../../src/protocol/intents.js";
import { activateScheduler } from "../../fez-relay/src/scheduler.js";

const sk = generateSecretKey();
const now = () => Math.floor(Date.now() / 1000);

function sealedIntent(sendAt: number, text = "hello future") {
  const inner = finalizeEvent({ kind: 47103, created_at: sendAt, tags: [["h", "chan1"]], content: text }, sk);
  const intent = finalizeEvent(
    { kind: 40006, created_at: now(), tags: [["h", "chan1"], ["send_at", String(sendAt)]], content: sealContent(inner) },
    sk
  );
  return { inner, intent };
}

function fakeApi(stored: unknown[] = []) {
  const injected: unknown[] = [];
  const observers: ((e: never) => void)[] = [];
  return {
    injected,
    emit: (e: unknown) => observers.forEach((cb) => cb(e as never)),
    api: {
      query: (filter: Record<string, unknown>) => {
        const kinds = filter.kinds as number[] | undefined;
        return stored.filter((e) => !kinds || kinds.includes((e as { kind: number }).kind)) as never[];
      },
      onEvent: (cb: (e: never) => void) => observers.push(cb),
      inject: (e: never) => { injected.push(e); return { accepted: true }; },
      log: () => {},
    },
  };
}

describe("relay scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms a stored sealed intent and injects the embedded event at send_at", () => {
    const { inner, intent } = sealedIntent(now() + 60);
    const { api, injected } = fakeApi([intent]);
    activateScheduler(api);
    expect(injected).toHaveLength(0);
    vi.advanceTimersByTime(61_000);
    expect(injected).toEqual([inner]);
  });

  it("fires overdue intents immediately on activate", () => {
    const { inner, intent } = sealedIntent(now() - 100);
    const { api, injected } = fakeApi([intent]);
    activateScheduler(api);
    vi.advanceTimersByTime(1);
    expect(injected).toEqual([inner]);
  });

  it("arms live intents arriving after activate", () => {
    const { api, injected, emit } = fakeApi([]);
    activateScheduler(api);
    const { inner, intent } = sealedIntent(now() + 30);
    emit(intent);
    vi.advanceTimersByTime(31_000);
    expect(injected).toEqual([inner]);
  });

  it("a tombstoned intent never fires; a live tombstone disarms", () => {
    const { intent } = sealedIntent(now() + 60);
    const tomb = finalizeEvent({ kind: 5, created_at: now(), tags: [["e", intent.id]], content: "" }, sk);
    const stored = fakeApi([intent, tomb]);
    activateScheduler(stored.api);
    vi.advanceTimersByTime(61_000);
    expect(stored.injected).toHaveLength(0);

    const live = fakeApi([]);
    activateScheduler(live.api);
    const second = sealedIntent(now() + 60);
    live.emit(second.intent);
    live.emit(finalizeEvent({ kind: 5, created_at: now(), tags: [["e", second.intent.id]], content: "" }, sk));
    vi.advanceTimersByTime(61_000);
    expect(live.injected).toHaveLength(0);
  });

  it("legacy plaintext intents are ignored (sentinel territory)", () => {
    const legacy = finalizeEvent(
      { kind: 40006, created_at: now(), tags: [["h", "chan1"], ["send_at", String(now() + 10)]], content: "plain text" },
      sk
    );
    const { api, injected } = fakeApi([legacy]);
    activateScheduler(api);
    vi.advanceTimersByTime(11_000);
    expect(injected).toHaveLength(0);
  });

  it("only tombstones from the intent's own author disarm it", () => {
    const { inner, intent } = sealedIntent(now() + 30);
    const strangerTomb = finalizeEvent({ kind: 5, created_at: now(), tags: [["e", intent.id]], content: "" }, generateSecretKey());
    const { api, injected } = fakeApi([intent, strangerTomb]);
    activateScheduler(api);
    vi.advanceTimersByTime(31_000);
    expect(injected).toEqual([inner]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-evals && npx vitest --run tests/relay-scheduler.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `packages/fez-relay/src/scheduler.ts`**

```ts
import type { StoredEvent } from "./relay.js";
import { parseSealed } from "../../../src/protocol/intents.js";

/**
 * The timestamp escrow (de-sentinel workstream 3): watches sealed 40006
 * intents and, at send_at, INJECTS the embedded author-signed event
 * through the relay's normal ingest pipeline. It authors nothing — the
 * signature in the envelope is the author's, injection re-validates it,
 * and re-release after a restart is a no-op because relays dedupe by id.
 *
 * Legacy plaintext intents are deliberately NOT handled here: releasing
 * one would require signing as the author, which the relay must never
 * do. The sentinel remains their executor.
 *
 * Built into the relay (default-on, --no-scheduler to disable) but
 * written against the extension-API subset so it can move to a
 * standalone relay extension without change.
 */

const KIND_SCHEDULED = 40006;
const KIND_DELETION = 5;
const MAX_DELAY = 2 ** 31 - 1;

export interface SchedulerApi {
  query(filter: Record<string, unknown>): StoredEvent[];
  onEvent(cb: (event: StoredEvent) => void): void;
  inject(event: StoredEvent): { accepted: boolean; reason?: string };
  log(line: string): void;
}

export function activateScheduler(api: SchedulerApi): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const done = new Set<string>();

  const disarm = (intentId: string) => {
    const t = timers.get(intentId);
    if (t) clearTimeout(t);
    timers.delete(intentId);
    done.add(intentId);
  };

  const fire = (intent: StoredEvent) => {
    timers.delete(intent.id);
    if (done.has(intent.id)) return;
    done.add(intent.id);
    const inner = parseSealed(intent.content);
    if (!inner) return;
    const verdict = api.inject(inner as StoredEvent);
    api.log(
      verdict.accepted
        ? `⏲ released sealed intent ${intent.id.slice(0, 8)}… → event ${inner.id.slice(0, 8)}…`
        : `⏲ sealed intent ${intent.id.slice(0, 8)}… not released (${verdict.reason ?? "refused"}) — likely already delivered`
    );
  };

  const arm = (intent: StoredEvent) => {
    if (done.has(intent.id) || timers.has(intent.id)) return;
    if (!parseSealed(intent.content)) return; // legacy plaintext — sentinel's job
    const at = Number(intent.tags.find((t) => t[0] === "send_at")?.[1]);
    if (!at) return;
    const delayMs = Math.min(Math.max(0, at * 1000 - Date.now()), MAX_DELAY);
    timers.set(intent.id, setTimeout(() => fire(intent), delayMs));
  };

  // Tombstones count only from the intent's own author — anyone else's
  // kind 5 naming the id is noise (same author-only rule clients apply).
  const tombstonedIds = (events: StoredEvent[], intents: Map<string, StoredEvent>): Set<string> => {
    const dead = new Set<string>();
    for (const t of events) {
      for (const tag of t.tags) {
        if (tag[0] !== "e" || !tag[1]) continue;
        const intent = intents.get(tag[1]);
        if (intent && intent.pubkey === t.pubkey) dead.add(tag[1]);
      }
    }
    return dead;
  };

  const intents = new Map<string, StoredEvent>(
    api.query({ kinds: [KIND_SCHEDULED] }).map((e) => [e.id, e])
  );
  const dead = tombstonedIds(api.query({ kinds: [KIND_DELETION] }), intents);
  for (const [id, intent] of intents) {
    if (dead.has(id)) done.add(id);
    else arm(intent);
  }
  const armed = timers.size;
  if (armed > 0) api.log(`⏲ scheduler armed ${armed} sealed intent(s)`);

  api.onEvent((event) => {
    if (event.kind === KIND_SCHEDULED) {
      intents.set(event.id, event);
      arm(event);
      return;
    }
    if (event.kind === KIND_DELETION) {
      for (const tag of event.tags) {
        if (tag[0] !== "e" || !tag[1]) continue;
        const intent = intents.get(tag[1]);
        if (intent && intent.pubkey === event.pubkey) disarm(tag[1]);
      }
    }
  });
}
```

Note the relative `../../../src/protocol/intents.js` import: fez-relay already depends on the root package (check its package.json — if it declares `@fezchat/protocol` as a dependency, import from `"@fezchat/protocol"` instead; use whichever form the package's existing imports use, and if neither exists, the relative leaf import is acceptable with a comment, matching fez-desktop's wire.ts precedent).

In `packages/fez-relay/src/cli.ts`: add `let scheduler = true;` to the flag block, `else if (arg === "--no-scheduler") scheduler = false;`, help-text line `--no-scheduler   don't execute sealed 40006 schedule intents`, and after the relay is constructed (after the extensions block so ordering is deterministic):

```ts
  if (scheduler) {
    const { activateScheduler } = await import("./scheduler.js");
    activateScheduler({
      query: (f) => relay.query(f as never),
      onEvent: (cb) => relay.onEvent(cb),
      inject: (e) => relay.inject(e),
      log: (line) => console.log(line),
    });
  }
```

(Adjust the four call shapes to the relay handle's real method names from Task 2 — they were built to match.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-evals && npx vitest --run tests/relay-scheduler.test.ts` — PASS. `cd packages/fez-relay && npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-relay/src/scheduler.ts packages/fez-relay/src/cli.ts packages/fez-evals/tests/relay-scheduler.test.ts
git commit -m "relay: sealed-intent scheduler — default-on timestamp escrow, extension-API-shaped"
```

---

### Task 4: `Wire.signEvent` + sealed `scheduleMessage`

**Files:**
- Modify: `packages/fez-client/src/index.ts` (Wire interface ~line 79-100; `scheduleMessage` ~line 978)
- Modify: `packages/fez-desktop/src/wire.ts` (expose `signEvent` — the sign step already exists inside `publish`, ~line 404-406 and the `invoke("sign_event", ...)` at ~line 59)
- Test: `packages/fez-evals/tests/sealed-schedule.test.ts`

**Interfaces:**
- Consumes: Task 1's `sealContent`.
- Produces: `Wire.signEvent?(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): WireEvent | Promise<WireEvent>` (optional — the TUI's wire at `src/cli/tui.ts:243` already provides exactly this shape; BrowserWire gains it here). `scheduleMessage` emits sealed intents when `signEvent` is available, legacy otherwise.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { parseSealed } from "../../../src/protocol/intents.js";
import { FezClient, type Wire } from "../../fez-client/src/index.js";

const sk = generateSecretKey();
const pk = getPublicKey(sk);

function fakeWire(withSign: boolean) {
  const published: { kind: number; tags: string[][]; content: string; created_at?: number }[] = [];
  const wire = {
    pubkey: pk,
    publish: async (tmpl: never) => {
      published.push(tmpl);
      return finalizeEvent({ ...(tmpl as object), created_at: Math.floor(Date.now() / 1000) } as never, sk);
    },
    ...(withSign
      ? { signEvent: (tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }) =>
            finalizeEvent({ created_at: Math.floor(Date.now() / 1000), ...tmpl } as never, sk) }
      : {}),
    subscribe: () => () => {},
    query: async () => [],
    encrypt: (_p: string, t: string) => t,
    decrypt: (_p: string, t: string) => t,
    sendDm: async () => "",
    unwrapDm: () => undefined,
    relays: ["ws://test"],
    relayInfo: async () => undefined,
  } as unknown as Wire;
  return { wire, published };
}

describe("sealed scheduleMessage", () => {
  it("seals when the wire can sign: embedded 47103 with created_at = sendAt", async () => {
    const { wire, published } = fakeWire(true);
    const client = new FezClient(wire);
    const sendAt = Math.floor(Date.now() / 1000) + 3600;
    await client.scheduleMessage("chan1", sendAt, "later!");
    expect(published).toHaveLength(1);
    const intent = published[0];
    expect(intent.kind).toBe(40006);
    expect(intent.tags).toContainEqual(["send_at", String(sendAt)]);
    const inner = parseSealed(intent.content)!;
    expect(inner.kind).toBe(47103);
    expect(inner.created_at).toBe(sendAt);
    expect(inner.content).toBe("later!");
    expect(inner.tags).toContainEqual(["h", "chan1"]);
  });

  it("falls back to legacy plaintext when the wire cannot sign", async () => {
    const { wire, published } = fakeWire(false);
    const client = new FezClient(wire);
    await client.scheduleMessage("chan1", 123, "later!");
    expect(published[0].content).toBe("later!");
    expect(parseSealed(published[0].content)).toBeUndefined();
  });
});
```

(If `FezClient`'s constructor requires more than the wire — check its signature — extend the fake minimally; the existing fez-evals client tests show the established fake-wire shape to copy.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-evals && npx vitest --run tests/sealed-schedule.test.ts` — FAIL (scheduleMessage emits plaintext in both cases).

- [ ] **Step 3: Implement**

`packages/fez-client/src/index.ts` — add to the `Wire` interface (after `publish`):

```ts
  /**
   * Sign WITHOUT publishing — sealed schedule intents embed a future-
   * dated, pre-signed event. Optional: a wire that can't provide it
   * degrades scheduleMessage to the legacy plaintext form (sentinel-
   * fired). The TUI's wire and BrowserWire both provide it.
   */
  signEvent?(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): WireEvent | Promise<WireEvent>;
```

Replace `scheduleMessage`:

```ts
  async scheduleMessage(channelId: string, sendAt: number, text: string): Promise<void> {
    if (this.wire.signEvent) {
      // Sealed intent: the FINAL message, signed now, dated send_at —
      // whoever executes (relay scheduler, sentinel) releases it
      // verbatim and never needs our key. See src/protocol/intents.ts.
      const inner = await this.wire.signEvent({
        kind: K.MESSAGE,
        tags: [["h", channelId]],
        content: text,
        created_at: sendAt,
      });
      await this.wire.publish({
        kind: K.SCHEDULED,
        tags: [["h", channelId], ["send_at", String(sendAt)]],
        content: JSON.stringify({ sealed: inner }),
      });
      return;
    }
    await this.wire.publish({
      kind: K.SCHEDULED,
      tags: [["h", channelId], ["send_at", String(sendAt)]],
      content: text,
    });
  }
```

(Use the client's existing constant for 47103 — grep for how `K` names the channel-message kind (`K.MESSAGE` or similar) and use that exact name. The sealed JSON is built inline rather than importing `sealContent` ONLY if fez-client cannot cleanly import the root protocol package — check how fez-client currently relates to the root package; if a clean import exists, use `sealContent(inner)`.)

`packages/fez-desktop/src/wire.ts` — BrowserWire: the `publish` method already signs then sends (~line 404: `const event = await this.sign(tmpl)` or inline invoke). Extract/expose:

```ts
  async signEvent(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    // same body as publish's signing step — the rustSigner invoke
  }
```

and have `publish` call `this.signEvent(tmpl)` then `publishSigned(event)` so there is ONE signing path. (The exact current shape is at wire.ts:404-416 and the `invoke("sign_event", …)` call at ~line 59 — refactor, don't duplicate.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-evals && npx vitest --run tests/sealed-schedule.test.ts` — PASS. `cd packages/fez-desktop && npx tsc --noEmit` — clean. Re-run any existing fez-evals client tests touching schedules.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-client/src/index.ts packages/fez-desktop/src/wire.ts packages/fez-evals/tests/sealed-schedule.test.ts
git commit -m "client: sealed schedule intents — Wire.signEvent seam, legacy fallback"
```

---

### Task 5: Sentinel — sealed support + the h/c bug fix

**Files:**
- Modify: `packages/fez-sentinel/src/index.ts` (the `fireIntent` function in the schedules block)
- Test: covered by the shared codec tests (Task 1) + the sentinel build; the fireIntent delta is small enough that its verification is the build plus the review-against-oracle.

**Interfaces:**
- Consumes: Task 1's `parseSealed` (add to the sentinel's `@fezchat/protocol` import list).
- Produces: sentinel fires sealed intents by publishing the embedded event verbatim; legacy plaintext keeps working — and actually starts working: the current code requires an `h` AND a `c` tag (`if (h && c)`), but `scheduleMessage` never set `c` (retired community tag), so legacy scheduled messages never fired. Drop the `c` requirement.

- [ ] **Step 1: Modify `fireIntent`**

Current (oracle):

```ts
    if (intent.kind === KIND_SCHEDULED) {
      const h = intent.tags.find((t) => t[0] === "h")?.[1];
      const c = intent.tags.find((t) => t[0] === "c")?.[1];
      if (h && c) {
        await relay.publish(client.signEvent({ kind: KIND_CHANNEL_MSG, tags: [["h", h]], content: intent.content }));
        console.log(`⏲ delivered scheduled message to channel ${h.slice(0, 8)}…`);
      }
    } else {
```

Replace with:

```ts
    if (intent.kind === KIND_SCHEDULED) {
      const sealed = parseSealed(intent.content);
      if (sealed) {
        // Sealed intent: release the author's own pre-signed event
        // verbatim. Idempotent — if the relay scheduler already released
        // it, the duplicate id is dropped at ingest.
        await relay.publish(sealed as never);
        console.log(`⏲ released sealed scheduled message ${sealed.id.slice(0, 8)}…`);
      } else {
        // Legacy plaintext. The old gate also required a retired "c"
        // tag scheduleMessage never set — legacy intents silently never
        // fired. h alone is the address.
        const h = intent.tags.find((t) => t[0] === "h")?.[1];
        if (h) {
          await relay.publish(client.signEvent({ kind: KIND_CHANNEL_MSG, tags: [["h", h]], content: intent.content }));
          console.log(`⏲ delivered scheduled message to channel ${h.slice(0, 8)}…`);
        }
      }
    } else {
```

Add `parseSealed` to the `@fezchat/protocol` import list at the top of the file. The tombstone publish after firing stays exactly as is (the sentinel signs as the owner-author — valid for both forms when the owner scheduled; for a sealed intent scheduled by a non-owner member the tombstone is simply ignored by clients as author-mismatched, which is harmless bookkeeping noise).

- [ ] **Step 2: Build + suite**

Run: `cd packages/fez-sentinel && npm run build` — clean. `cd packages/fez-evals && npx vitest --run tests/sealed-intents.test.ts` — still green.

- [ ] **Step 3: Commit**

```bash
git add packages/fez-sentinel/src/index.ts
git commit -m "sentinel: release sealed schedule intents; fix legacy firing (retired c-tag gate)"
```

---

### Task 6: Desktop reminders while open + copy updates

**Files:**
- Modify: `packages/fez-client/src/index.ts` (reminder arming + `reminderDue` emit)
- Modify: `packages/fez-desktop/src/App.tsx` (listener with sentinel deferral)
- Modify: `packages/fez-desktop/src/RemindersPane.tsx` (executor copy, ~lines 9-10)
- Modify: `packages/fez-desktop/src/commands.ts` (/schedule copy, ~lines 130-136)
- Test: `packages/fez-evals/tests/reminder-arming.test.ts`

**Interfaces:**
- Consumes: the client's existing `K.REMINDER` (40007), `wire.decrypt`, `wire.query`, `wire.subscribe`, its `emit` mechanism (grep how existing events like `"channelsChanged"` are emitted/listened — reuse it identically).
- Produces: `FezClient` emits `"reminderDue"` with `(note: string)` when one of the OWN user's reminders reaches its time while the client is alive; arming happens in whatever init path hydrates other subscriptions (find where the client sets up its live subscription and add reminder hydration beside it). Timer math per Global Constraints; tombstoned (kind 5, own-author) reminders never fire; a reminder firing does NOT tombstone (the sentinel/owner semantics stay unchanged — the desktop only notifies).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// fake-wire shape: copy from tests/sealed-schedule.test.ts (Task 4), extended
// with a controllable query/subscribe so the test can hand the client a
// stored 40007 whose content is JSON.stringify({note, remind_at}) —
// the fake wire's encrypt/decrypt are identity functions, matching how
// setReminder encrypts (self-NIP-44) and the client decrypts its own.

describe("client reminder arming", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits reminderDue at remind_at for an own stored reminder", async () => {
    // stored reminder: remind_at = now + 60, note "stretch"
    // construct client, run its init/hydration path, listen for "reminderDue"
    // advance 61s → expect handler called with "stretch"
  });

  it("a tombstoned reminder never fires", async () => {
    // same, plus own-author kind 5 e-tagging the reminder id → advance → no emit
  });

  it("a reminder arriving live over subscribe arms too", async () => {
    // push through the fake wire's subscription callback → advance → emit
  });
});
```

(The comment lines are implementer instructions: the exact client construction and hydration entry point depend on FezClient's real init surface — find how the existing fez-evals client tests construct and hydrate a FezClient and mirror that. The three behaviors asserted are the requirement.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-evals && npx vitest --run tests/reminder-arming.test.ts` — FAIL.

- [ ] **Step 3: Implement**

In `packages/fez-client/src/index.ts`, beside the client's existing live-subscription setup:

```ts
  /** Armed reminder timers (id → timer); the client fires its OWN
   * reminders while alive — the desktop toasts them, the sentinel keeps
   * covering app-closed delivery (hosts dedupe via runner_status). */
  private reminderTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private async armReminder(event: { id: string; content: string }): Promise<void> {
    if (this.reminderTimers.has(event.id)) return;
    try {
      const body = JSON.parse(await this.wire.decrypt(this.pubkey, event.content)) as { note?: string; remind_at?: number };
      if (typeof body.remind_at !== "number") return;
      const delayMs = Math.min(Math.max(0, body.remind_at * 1000 - Date.now()), 2 ** 31 - 1);
      this.reminderTimers.set(
        event.id,
        setTimeout(() => {
          this.reminderTimers.delete(event.id);
          this.emit("reminderDue", body.note || "(reminder)");
        }, delayMs)
      );
    } catch { /* not decryptable/parsable — not ours or legacy-broken */ }
  }
```

Hydration (where other kinds hydrate): query `{ kinds: [K.REMINDER], authors: [this.pubkey] }` and own-author kind-5 tombstones; arm non-tombstoned. Live: extend the existing subscription filters (or add one) with `{ kinds: [K.REMINDER], authors: [this.pubkey] }` → `armReminder`; own-author kind 5 e-tagging an armed id → clearTimeout + delete. Wire the emit through the client's existing `emit` exactly as `"channelsChanged"` does (grep its declaration — if there's an event-name union type, add `"reminderDue"` to it).

In `packages/fez-desktop/src/App.tsx`, beside the other `client.on(...)` handlers (~line 446 block):

```ts
    client.on("reminderDue", ((note: string) => {
      void (async () => {
        // The sentinel delivers OS notifications when it's alive — one
        // notifier per machine (same rule as the summoner).
        const sentinel = await invoke<boolean>("runner_status").catch(() => false);
        if (!sentinel) toast.info(`⏰ ${note}`, 0);
      })();
    }) as never);
```

(Match the surrounding handlers' cast style and ensure `invoke` is imported in App.tsx — it already is.)

Copy changes:
- `RemindersPane.tsx` ~line 9-10: "The sentinel is the executor; this pane is the ledger" → "Delivered while fez is open; install the fleet watcher (`fez sentinel-install`) for delivery when it isn't. This pane is the ledger."
- Any pane copy saying "The sentinel delivers them" → "Delivered when due — by fez while it's open, by the fleet watcher otherwise."
- `commands.ts` /schedule result copy ("the sentinel sends it") → "sealed and delivered by the relay at the appointed time."

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-evals && npx vitest --run tests/reminder-arming.test.ts tests/sealed-schedule.test.ts` — PASS. `cd packages/fez-desktop && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-client/src/index.ts packages/fez-desktop/src/App.tsx packages/fez-desktop/src/RemindersPane.tsx packages/fez-desktop/src/commands.ts packages/fez-evals/tests/reminder-arming.test.ts
git commit -m "client+desktop: reminders fire in the open app; schedule/reminder copy reflects relay delivery"
```

---

### Task 7: End-to-end verification + docs touch

**Files:**
- Modify: `packages/fez-relay/README.md` (scheduler section)

**Interfaces:** consumes everything.

- [ ] **Step 1: Automated end-to-end test — extend `packages/fez-evals/tests/relay-inject.test.ts` OR a new `tests/schedule-e2e.test.ts`**

One test that exercises the real chain with a real in-process relay (same harness as Task 2): client-side sealed intent built with `finalizeEvent` (as in Task 3's helper) → published to the relay over the wire → `activateScheduler` wired to the real relay's query/onEvent/inject → advance past send_at (real 1-2s timeout rather than fake timers if the relay harness needs real IO; keep send_at = now+1) → assert a ws subscriber on kinds [47103] received the embedded event, and that a second scheduler activation does not double-deliver (query returns one copy).

- [ ] **Step 2: Full suite + builds**

```bash
cd packages/fez-evals && npx vitest --run tests/sealed-intents.test.ts tests/relay-inject.test.ts tests/relay-scheduler.test.ts tests/sealed-schedule.test.ts tests/reminder-arming.test.ts
cd packages/fez-relay && npm run build
cd packages/fez-sentinel && npm run build
cd packages/fez-desktop && npx tsc --noEmit
```

All green before proceeding.

- [ ] **Step 3: README section**

Append to `packages/fez-relay/README.md`:

```markdown
## Scheduler

The relay executes sealed 40006 schedule intents by default: the client
signs the final message at schedule time (`created_at = send_at`) and
embeds it in the intent; at the appointed time the relay injects the
embedded, author-signed event through its normal ingest pipeline. The
relay signs nothing — it is a timestamp escrow, not an author. Disable
with `--no-scheduler`. Legacy plaintext intents are ignored here (the
sentinel fires those). Cancel by tombstoning the intent (kind 5) before
`send_at`.
```

- [ ] **Step 4: Commit**

```bash
git add packages/fez-relay/README.md packages/fez-evals/tests
git commit -m "scheduler: end-to-end release test + relay README"
```
