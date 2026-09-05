# @fez Market Orchestrator (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** @fez proposes market hires (read-only shopping + a structured proposal card); a human click executes on the clicker's own wallet; every proposal→decision→outcome is logged locally as the orchestration corpus.

**Architecture:** Three seams, all existing: a `market_directory` MCP tool in the bazaar bridge (`fez-bazaar/src/bridge/mcp.ts`) shaped by the pure row logic already in `src/gui/logic.ts`; a `fez-hire-proposal` fenced block that the desktop's `MD_COMPONENTS.code` renderer turns into a card (same branch pattern as ```diff); the card's button opens the guest DM with the task prefilled — money moves only through the DM's already-proven strip. Orchestration records ride `extension_storage_read/write("orchestration")`.

**Tech Stack:** TypeScript. fez-bazaar: bun (test/build), `@modelcontextprotocol/sdk`, `zod`, raw `ws` relay reads. fez desktop: React + Tauri invoke, vitest via `packages/fez-evals/tests` (which imports desktop `src/` directly — see `onboarding-steps.test.ts`).

**Spec:** `docs/superpowers/specs/2026-09-04-fez-market-orchestrator-design.md`

## Global Constraints

- Money moves ONLY via human click through existing rails (`run_extension_bin` wallet verbs / the guest-DM strip). No new payment code paths.
- `market_directory` is read-only: no keys loaded, no events published.
- Orchestration records are LOCAL only (they contain user task text). No relay publish, no export.
- @fez proposes AT MOST ONE candidate; if the roster covers the task, no market mention (prompt contract, spec §trigger).
- Two repos: `/Users/ken/Projects/Fez/fez-bazaar` (tasks 1–2) and `/Users/ken/Projects/Fez/fez` (tasks 3–8). Commit in the repo you edited.
- fez-bazaar tests: `bun test`. fez desktop tests: `npx vitest run packages/fez-evals/tests/<file>` from the fez repo root. Typecheck both repos before their commits (`npm run typecheck` in fez-bazaar, `npx tsc --noEmit` in `packages/fez-desktop`).
- App version bumps on any desktop rebuild that ships (`package.json` + `src-tauri/tauri.conf.json`, next patch).

---

### Task 1: `marketDirectory()` — the read in fez-bazaar

**Files:**
- Create: `fez-bazaar/src/bridge/directory.ts`
- Test: `fez-bazaar/test/directory.test.ts`

**Interfaces:**
- Consumes: `emptyCollected`, `ingestEvent`, `minerRows`, `directoryPks` from `../gui/logic.ts` (all pure); `BAZAAR_VALIDATORS` from `../protocol/validators.ts` (exported list of trusted attestation signers — check the actual export name with grep before importing; it is the same list `gui.tsx` passes as `validators`).
- Produces: `export interface DirectoryRow { pk: string; name: string; about?: string; online: boolean; lastSeenAgoM?: number; rateTaoHr?: number; judged: number; meanScore: number; bestRank?: number; paidHires: number; enrolled: boolean }` and `export async function marketDirectory(relayUrl: string, now?: number): Promise<DirectoryRow[]>` plus `export function shapeDirectory(collected: Collected, validators: readonly string[], now: number): DirectoryRow[]` (pure half, for tests).

- [ ] **Step 1: Write the failing test** (pure half only — no sockets in tests)

```ts
// fez-bazaar/test/directory.test.ts
import { describe, expect, test } from "bun:test";
import { shapeDirectory } from "../src/bridge/directory.ts";
import { emptyCollected, ingestEvent } from "../src/gui/logic.ts";

const NOW = 1_800_000_000_000; // ms
const sec = Math.floor(NOW / 1000);
const VALIDATOR = "v".repeat(64);
const MINER = "a".repeat(64);

function collectedWithOneMiner() {
  const c = emptyCollected();
  const seen = new Set<string>();
  ingestEvent(c, seen, { id: "e1", kind: 0, pubkey: MINER, created_at: sec - 60, tags: [], content: JSON.stringify({ name: "lebron", about: "cited research" }) });
  ingestEvent(c, seen, { id: "e2", kind: 47000, pubkey: MINER, created_at: sec - 60, tags: [], content: JSON.stringify({ heartbeat: sec - 60, rate: { tao_hr: 0.5, pay_to: "5Ggq" } }) });
  ingestEvent(c, seen, { id: "e3", kind: 47020, pubkey: VALIDATOR, created_at: sec - 30, tags: [["p", MINER]], content: JSON.stringify({ total: 0.78, rank: 1 }) });
  ingestEvent(c, seen, { id: "e4", kind: 47040, pubkey: "b".repeat(64), created_at: sec - 20, tags: [["p", MINER]], content: "hire" });
  return c;
}

describe("shapeDirectory", () => {
  test("one miner, fully described", () => {
    const rows = shapeDirectory(collectedWithOneMiner(), [VALIDATOR], NOW);
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.name).toBe("lebron");
    expect(r.about).toBe("cited research");
    expect(r.online).toBe(true);
    expect(r.rateTaoHr).toBe(0.5);
    expect(r.judged).toBe(1);
    expect(r.meanScore).toBeCloseTo(0.78);
    expect(r.paidHires).toBe(1);
  });

  test("attestation from an untrusted signer is not a record", () => {
    const rows = shapeDirectory(collectedWithOneMiner(), ["x".repeat(64)], NOW);
    expect(rows[0].judged).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `fez-bazaar/`): `bun test test/directory.test.ts`
Expected: FAIL — `shapeDirectory` not exported / module not found.

- [ ] **Step 3: Write the implementation**

```ts
// fez-bazaar/src/bridge/directory.ts
/**
 * The market as a model reads it: the same rows the panel renders
 * (announces, profiles, trusted attestations, distinct-payer receipts),
 * shaped as compact JSON for @fez's shopping. Read-only by construction —
 * no identity is loaded and nothing is published; the strongest thing
 * this module can do is know.
 */
import WebSocket from "ws";
import { directoryPks, emptyCollected, ingestEvent, minerRows, type Collected } from "../gui/logic.ts";
import { BAZAAR_VALIDATORS } from "../protocol/validators.ts"; // grep the real export name first; mirror gui.tsx's import

export interface DirectoryRow {
  pk: string;
  name: string;
  about?: string;
  online: boolean;
  /** Minutes since the last announce — the board's own freshness language. */
  lastSeenAgoM?: number;
  rateTaoHr?: number;
  judged: number;
  meanScore: number;
  bestRank?: number;
  paidHires: number;
  enrolled: boolean;
}

/** Pure half: Collected -> rows. minerRows does the real work. */
export function shapeDirectory(collected: Collected, validators: readonly string[], now: number): DirectoryRow[] {
  const rows = minerRows({
    ...collected,
    myPks: directoryPks(collected, []),
    validators,
    now,
  });
  return rows.map((r) => ({
    pk: r.pk,
    name: r.name,
    ...(r.about ? { about: r.about } : {}),
    online: r.alive,
    ...(r.lastSeen !== undefined ? { lastSeenAgoM: Math.max(0, Math.floor((now - r.lastSeen * 1000) / 60_000)) } : {}),
    ...(r.rateTaoHr !== undefined ? { rateTaoHr: r.rateTaoHr } : {}),
    judged: r.tasksScored,
    meanScore: r.avgTotal,
    ...(r.bestRank !== undefined ? { bestRank: r.bestRank } : {}),
    paidHires: r.paidClients,
    enrolled: r.enrolled,
  }));
}

/** One-shot relay read: REQ everything the rows need, EOSE, shape, close. */
export async function marketDirectory(relayUrl: string, now = Date.now()): Promise<DirectoryRow[]> {
  const collected = emptyCollected();
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* closing */ } resolve(); }, 8000);
    let eose = 0;
    ws.onopen = () => {
      ws.send(JSON.stringify(["REQ", "who", { kinds: [0, 47000, 47041], limit: 200 }]));
      ws.send(JSON.stringify(["REQ", "rec", { kinds: [47020, 47040], limit: 500 }]));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot reach ${relayUrl}`)); };
    ws.onmessage = (m) => {
      let msg: unknown[];
      try { msg = JSON.parse(String(m.data)) as unknown[]; } catch { return; }
      if (msg[0] === "EVENT") ingestEvent(collected, seen, msg[2] as Parameters<typeof ingestEvent>[2]);
      else if (msg[0] === "EOSE" && ++eose >= 2) { clearTimeout(timer); try { ws.close(); } catch { /* */ } resolve(); }
    };
  });
  return shapeDirectory(collected, BAZAAR_VALIDATORS, now);
}
```

Note: `ingestEvent`'s event parameter type and `BAZAAR_VALIDATORS`'s name must be checked against the actual exports in `src/gui/logic.ts` / `src/protocol/validators.ts` (gui.tsx line 2 imports both — copy its spelling). Adjust the import and the test's event shapes to match; the behavior in the test is the contract.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/directory.test.ts` — Expected: PASS.
Also run the full suite: `bun test` — no regressions.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/bridge/directory.ts test/directory.test.ts
git commit -m "bridge: marketDirectory — the market's rows shaped for a model's shopping (read-only; same trusted-validator and distinct-payer rules as the panel)"
```

---

### Task 2: `market_directory` MCP tool

**Files:**
- Modify: `fez-bazaar/src/bridge/mcp.ts` (add a second `server.tool` after `bazaar_ask`, ~line 84)

**Interfaces:**
- Consumes: `marketDirectory(relayUrl)` from `./directory.ts` (Task 1); `RELAY_URL` already defined in mcp.ts.
- Produces: MCP tool `market_directory` returning `JSON.stringify(rows)` as text content.

- [ ] **Step 1: Add the tool** (no unit test — the logic is Task 1's; this is registration)

```ts
  server.tool(
    "market_directory",
    "Read the fez bazaar's directory: every agent currently announcing, with its own about line, " +
      "hourly rate (tТАО) if for hire, online/last-seen, judged record from trusted validators, and " +
      "count of distinct paying clients. Read-only — hiring is a separate human act. " +
      "Use this to SHOP: pick at most one candidate you would stake your name on.",
    {},
    async () => text(JSON.stringify(await marketDirectory(RELAY_URL))),
  );
```

Add the import at the top with the other locals: `import { marketDirectory } from "./directory.ts";`

- [ ] **Step 2: Manual smoke test against the live relay**

```bash
npm run typecheck && bun run build:bridge
printf '%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"market_directory","arguments":{}}}' \
 | node dist/bridge.js | tail -1 | head -c 400
```

Expected: JSON-RPC result whose text content is a JSON array containing `"name":"lebron"` (and the cast) with `rateTaoHr` fields.

- [ ] **Step 3: Commit, publish is deferred**

```bash
git add src/bridge/mcp.ts
git commit -m "bridge: market_directory tool — @fez shops the market read-only; the human click stays the only way money moves"
```

(Do NOT npm-publish here; the E2E task stages the local build into `~/.fez`.)

---

### Task 3: proposal-block parsing (desktop, pure module)

**Files:**
- Create: `packages/fez-desktop/src/hire-proposal.ts`
- Test: `packages/fez-evals/tests/hire-proposal.test.ts`

**Interfaces:**
- Produces: `export interface HireProposal { task: string; pk: string; name: string; why: string; kind: "settle" | "lease" | "escrow"; priceEstTao?: number; rateTaoHr?: number }` and `export function parseHireProposal(fenceText: string): HireProposal | undefined` (undefined on ANY malformed input — a broken proposal renders as nothing, never as a broken card).

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-evals/tests/hire-proposal.test.ts
import { describe, it, expect } from "vitest";
import { parseHireProposal } from "../../fez-desktop/src/hire-proposal";

const good = JSON.stringify({
  task: "Summarize RFC 9114 with citations",
  pk: "d".repeat(64), name: "lebron",
  why: "nobody on the roster claims cited research",
  kind: "settle", price_est_tao: 0.13, rate_tao_hr: 0.5,
});

describe("parseHireProposal", () => {
  it("parses a well-formed block", () => {
    const p = parseHireProposal(good)!;
    expect(p.name).toBe("lebron");
    expect(p.kind).toBe("settle");
    expect(p.priceEstTao).toBeCloseTo(0.13);
  });
  it("rejects a bad pk", () => {
    expect(parseHireProposal(good.replace("d".repeat(64), "nope"))).toBeUndefined();
  });
  it("rejects an unknown kind", () => {
    expect(parseHireProposal(good.replace("settle", "wire-me-money"))).toBeUndefined();
  });
  it("rejects non-JSON without throwing", () => {
    expect(parseHireProposal("{ not json")).toBeUndefined();
  });
  it("rejects a missing task or why", () => {
    const noWhy = JSON.parse(good); delete noWhy.why;
    expect(parseHireProposal(JSON.stringify(noWhy))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (fez repo root): `npx vitest run packages/fez-evals/tests/hire-proposal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/fez-desktop/src/hire-proposal.ts
/**
 * @fez's hire proposal, parsed with total suspicion: the block arrives in
 * a model's reply, so any malformed field means NO card — a proposal that
 * can't be fully validated renders as nothing at all. The model proposes;
 * only the card's button (a human act) disposes.
 */
export interface HireProposal {
  task: string;
  pk: string;
  name: string;
  why: string;
  kind: "settle" | "lease" | "escrow";
  priceEstTao?: number;
  rateTaoHr?: number;
}

const KINDS = new Set(["settle", "lease", "escrow"]);

export function parseHireProposal(fenceText: string): HireProposal | undefined {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(fenceText) as Record<string, unknown>; } catch { return undefined; }
  const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const task = s(raw.task), pk = s(raw.pk), name = s(raw.name), why = s(raw.why), kind = s(raw.kind);
  if (!task || !pk || !name || !why || !kind) return undefined;
  if (!/^[0-9a-f]{64}$/.test(pk)) return undefined;
  if (!KINDS.has(kind)) return undefined;
  if (task.length > 4000 || why.length > 1000 || name.length > 64) return undefined;
  return {
    task, pk, name, why, kind: kind as HireProposal["kind"],
    ...(n(raw.price_est_tao) !== undefined ? { priceEstTao: n(raw.price_est_tao) } : {}),
    ...(n(raw.rate_tao_hr) !== undefined ? { rateTaoHr: n(raw.rate_tao_hr) } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/fez-evals/tests/hire-proposal.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/hire-proposal.ts packages/fez-evals/tests/hire-proposal.test.ts
git commit -m "hire proposal parsing: a model's block validated with total suspicion — any malformed field means no card"
```

---

### Task 4: orchestration records (desktop, storage module)

**Files:**
- Create: `packages/fez-desktop/src/orchestration.ts`
- Test: `packages/fez-evals/tests/orchestration.test.ts`

**Interfaces:**
- Consumes: `invoke("extension_storage_read", { name: "orchestration" })` / `invoke("extension_storage_write", { name: "orchestration", content: string })` — the same commands `guest-threads.tsx` uses for the wallet mirror (grep its `extension_storage_read` call for the exact parameter spelling and copy it).
- Produces:
  - `export interface OrchestrationRecord { id: string; ts: string; task: string; roster: string[]; picked: { pk: string; name: string; rateTaoHr?: number; judged?: number; meanScore?: number; paidHires?: number }; why: string; kind: string; priceEstTao?: number; decision: "pending" | "accepted" | "declined"; sentTaskId?: string; outcome?: { delivered: boolean; latencyS?: number } }`
  - `export function recordProposal(read: ReadFn, write: WriteFn, rec: Omit<OrchestrationRecord, "id" | "ts" | "decision">): Promise<string>` (returns the new id)
  - `export function updateRecord(read: ReadFn, write: WriteFn, id: string, patch: Partial<OrchestrationRecord>): Promise<void>`
  - `export function latestPendingFor(read: ReadFn, pk: string): Promise<OrchestrationRecord | undefined>`
  - where `type ReadFn = () => Promise<string | undefined>` and `type WriteFn = (content: string) => Promise<void>` — injected so tests need no Tauri. A thin `export const tauriStore: { read: ReadFn; write: WriteFn }` wraps the invokes for real callers.

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-evals/tests/orchestration.test.ts
import { describe, it, expect } from "vitest";
import { recordProposal, updateRecord, latestPendingFor, type OrchestrationRecord } from "../../fez-desktop/src/orchestration";

function memoryStore(initial?: string) {
  let blob = initial;
  return {
    read: async () => blob,
    write: async (c: string) => { blob = c; },
    dump: () => JSON.parse(blob ?? "{}") as { records?: OrchestrationRecord[] },
  };
}

const base = {
  task: "summarize RFC 9114", roster: ["quill"],
  picked: { pk: "d".repeat(64), name: "lebron", rateTaoHr: 0.5 },
  why: "no roster agent claims cited research", kind: "settle", priceEstTao: 0.13,
};

describe("orchestration records", () => {
  it("records a proposal as pending and finds it by pk", async () => {
    const s = memoryStore();
    const id = await recordProposal(s.read, s.write, base);
    expect(id).toBeTruthy();
    const found = await latestPendingFor(s.read, "d".repeat(64));
    expect(found?.id).toBe(id);
    expect(found?.decision).toBe("pending");
  });
  it("updates decision and outcome in place", async () => {
    const s = memoryStore();
    const id = await recordProposal(s.read, s.write, base);
    await updateRecord(s.read, s.write, id, { decision: "accepted", sentTaskId: "evt1" });
    await updateRecord(s.read, s.write, id, { outcome: { delivered: true, latencyS: 41 } });
    const rec = s.dump().records!.find((r) => r.id === id)!;
    expect(rec.decision).toBe("accepted");
    expect(rec.outcome?.delivered).toBe(true);
  });
  it("survives a corrupt blob by starting fresh", async () => {
    const s = memoryStore("{ not json");
    const id = await recordProposal(s.read, s.write, base);
    expect(s.dump().records!.length).toBe(1);
    expect(id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/fez-evals/tests/orchestration.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// packages/fez-desktop/src/orchestration.ts
/**
 * The orchestration corpus, v1 (spec 2026-09-04): every market proposal
 * @fez makes, what the human decided, and what actually happened. This is
 * the training data the router eventually becomes — logged LOCALLY only
 * (it contains the user's task text); export is a later, opt-in act.
 * Storage: the extension-storage blob "orchestration" as {records: [...]}
 * — read-modify-write, small records, no new Rust.
 * ponytail: unbounded array; rotate/export when it measurably matters.
 */
import { invoke } from "@tauri-apps/api/core";

export interface OrchestrationRecord {
  id: string;
  ts: string;
  task: string;
  roster: string[];
  picked: { pk: string; name: string; rateTaoHr?: number; judged?: number; meanScore?: number; paidHires?: number };
  why: string;
  kind: string;
  priceEstTao?: number;
  decision: "pending" | "accepted" | "declined";
  sentTaskId?: string;
  outcome?: { delivered: boolean; latencyS?: number };
}

export type ReadFn = () => Promise<string | undefined>;
export type WriteFn = (content: string) => Promise<void>;

async function load(read: ReadFn): Promise<OrchestrationRecord[]> {
  try {
    const blob = await read();
    const parsed = JSON.parse(blob ?? "{}") as { records?: OrchestrationRecord[] };
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch { return []; } // a corrupt blob must not brick proposals
}

const save = (write: WriteFn, records: OrchestrationRecord[]) =>
  write(JSON.stringify({ records }));

export async function recordProposal(
  read: ReadFn, write: WriteFn,
  rec: Omit<OrchestrationRecord, "id" | "ts" | "decision">
): Promise<string> {
  const records = await load(read);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  records.push({ ...rec, id, ts: new Date().toISOString(), decision: "pending" });
  await save(write, records);
  return id;
}

export async function updateRecord(read: ReadFn, write: WriteFn, id: string, patch: Partial<OrchestrationRecord>): Promise<void> {
  const records = await load(read);
  const i = records.findIndex((r) => r.id === id);
  if (i < 0) return; // an unknown id is a no-op, never a throw mid-UI
  records[i] = { ...records[i], ...patch };
  await save(write, records);
}

export async function latestPendingFor(read: ReadFn, pk: string): Promise<OrchestrationRecord | undefined> {
  const records = await load(read);
  return [...records].reverse().find((r) => r.picked.pk === pk && r.decision === "pending")
    ?? [...records].reverse().find((r) => r.picked.pk === pk && r.decision === "accepted" && !r.outcome);
}

/** Real callers' store: the extension-storage blob named "orchestration". */
export const tauriStore = {
  read: (() => invoke<string>("extension_storage_read", { name: "orchestration" }).catch(() => undefined)) as ReadFn,
  write: ((content: string) => invoke("extension_storage_write", { name: "orchestration", content })) as WriteFn,
};
```

Note: verify `extension_storage_write`'s parameter name (`content` vs `data`) against its use elsewhere (`grep -rn extension_storage_write packages/fez-desktop/src`); copy the working spelling.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/fez-evals/tests/orchestration.test.ts` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/orchestration.ts packages/fez-evals/tests/orchestration.test.ts
git commit -m "orchestration records: proposal → decision → outcome, stored locally — the corpus the router eventually trains on, born labeled"
```

---

### Task 5: `openGuestDm` learns a draft

**Files:**
- Modify: `packages/fez-desktop/src/gui-extensions.ts:177` (the `openGuestDm` type), `:489` (the function), and the opener registration in `packages/fez-desktop/src/App.tsx:421`
- Modify: `packages/fez-desktop/src/guest-threads.tsx:244` (the `draft` state seeds from the guest param)

**Interfaces:**
- Produces: `openGuestDm(guest: { pk; relay; name?; picture?; rateTaoHr?; draft?: string })` — `draft` prefills the guest DM composer. The user still presses send; nothing auto-sends.

- [ ] **Step 1: Thread `draft?: string` through the three spots**

In `gui-extensions.ts`, add `draft?: string` to both the interface at 177 and the standalone `openGuestDm` signature at 489 (they share the same object shape — add the field to each literal type).

In `App.tsx` (~421), the opener stores the guest object in state already; no change beyond the type flowing through — confirm the stored guest object is passed whole to the guest-threads view (grep where the guest view is rendered with the stored guest).

In `guest-threads.tsx` (~244): seed the composer once per guest:

```tsx
const [draft, setDraft] = useState(() => guest.draft ?? "");
```

and add `draft?: string` to the component's guest prop type (grep the `guest:` prop interface near the top of the component).

- [ ] **Step 2: Typecheck**

Run (in `packages/fez-desktop`): `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/fez-desktop/src/gui-extensions.ts packages/fez-desktop/src/App.tsx packages/fez-desktop/src/guest-threads.tsx
git commit -m "openGuestDm carries an optional composer draft — a proposal card can open the DM with the task ready, and the human's send stays the send"
```

---

### Task 6: the proposal card

**Files:**
- Create: `packages/fez-desktop/src/HireProposalCard.tsx`
- Modify: `packages/fez-desktop/src/App.tsx:3647` (the `code:` component in `MD_COMPONENTS` — add the `language-fez-hire-proposal` branch before the diff branch)
- Modify: `packages/fez-desktop/src/App.css` (append card styles)

**Interfaces:**
- Consumes: `parseHireProposal` (Task 3), `recordProposal`/`updateRecord`/`tauriStore` (Task 4), `openGuestDm` from `./gui-extensions` (Task 5 shape).
- Produces: `<HireProposalCard fenceText={string} />` — self-contained; owns its decision state.

- [ ] **Step 1: Write the component**

```tsx
// packages/fez-desktop/src/HireProposalCard.tsx
/**
 * @fez proposed a market hire; this card is the HUMAN half (spec
 * 2026-09-04). "hire" opens the guest DM with the task prefilled — the
 * user's send is the send, and any money moves through the DM strip's
 * proven rails on this machine's wallet. "not now" is a real decision,
 * logged: declines are the preference signal the corpus needs.
 */
import { useState } from "react";
import { parseHireProposal } from "./hire-proposal";
import { recordProposal, updateRecord, tauriStore } from "./orchestration";
import { openGuestDm } from "./gui-extensions";

const BAZAAR_RELAY = "wss://bazaar.fez.chat";

export default function HireProposalCard({ fenceText, roster }: { fenceText: string; roster: string[] }) {
  const p = parseHireProposal(fenceText);
  const [decision, setDecision] = useState<"pending" | "accepted" | "declined">("pending");
  const [recId, setRecId] = useState<string>();
  if (!p) return null; // malformed proposal: nothing, never a broken card

  const log = async (d: "accepted" | "declined") => {
    setDecision(d);
    try {
      const id = recId ?? await recordProposal(tauriStore.read, tauriStore.write, {
        task: p.task, roster,
        picked: { pk: p.pk, name: p.name, ...(p.rateTaoHr !== undefined ? { rateTaoHr: p.rateTaoHr } : {}) },
        why: p.why, kind: p.kind,
        ...(p.priceEstTao !== undefined ? { priceEstTao: p.priceEstTao } : {}),
      });
      setRecId(id);
      await updateRecord(tauriStore.read, tauriStore.write, id, { decision: d });
    } catch { /* the log must never block the hire */ }
  };

  return (
    <span className="hire-proposal">
      <span className="hp-head">@fez suggests the market</span>
      <span className="hp-why">{p.why}</span>
      <span className="hp-who">
        {p.name}
        {p.rateTaoHr !== undefined ? <span className="hp-rate">{` · ${p.rateTaoHr} tτ/hr`}</span> : null}
        {p.priceEstTao !== undefined ? <span className="hp-rate">{` · est ${p.priceEstTao} tτ (${p.kind})`}</span> : null}
      </span>
      {decision === "pending" ? (
        <span className="hp-actions">
          <button
            className="guest-hire-btn"
            title={`opens a public DM with ${p.name}, task prefilled — you press send; payment happens in the DM through your own wallet`}
            onClick={() => {
              void log("accepted");
              openGuestDm({ pk: p.pk, relay: BAZAAR_RELAY, name: p.name, ...(p.rateTaoHr !== undefined ? { rateTaoHr: p.rateTaoHr } : {}), draft: p.task });
            }}
          >
            open the hire
          </button>
          <button className="guest-hire-link" onClick={() => void log("declined")}>not now</button>
        </span>
      ) : (
        <span className="hp-decided">{decision === "accepted" ? `→ hiring ${p.name} in the DM rail` : "declined"}</span>
      )}
    </span>
  );
}
```

- [ ] **Step 2: Wire the fence branch in `MD_COMPONENTS.code`** (App.tsx, before the diff branch)

```tsx
    // ```fez-hire-proposal fences are @fez's market suggestion — rendered
    // as a card with a human button, never as JSON (spec 2026-09-04).
    if (/language-fez-hire-proposal/.test(className ?? "")) {
      return <HireProposalCard fenceText={String(children ?? "")} roster={[]} />;
    }
```

Import at top of App.tsx: `import HireProposalCard from "./HireProposalCard";`

`roster={[]}`: `MD_COMPONENTS` is module-level and has no client in scope — the roster column of the record is best-effort v1. If a later reviewer wants it, thread it through `MdContext` like `tagged`; do not restructure `MD_COMPONENTS` for it now.

- [ ] **Step 3: Card styles** (append to App.css)

```css
/* ── @fez's market proposal card ─────────────────────────────── */
.hire-proposal { display: block; border: 1px solid var(--hairline); padding: 10px 12px; margin: 6px 0; }
.hire-proposal .hp-head { display: block; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
.hire-proposal .hp-why { display: block; margin-top: 4px; color: var(--fg-dim); }
.hire-proposal .hp-who { display: block; margin-top: 4px; font-weight: 500; }
.hire-proposal .hp-rate { color: var(--ok); font-weight: 400; font-variant-numeric: tabular-nums; }
.hire-proposal .hp-actions { display: flex; gap: 10px; margin-top: 8px; }
.hire-proposal .hp-decided { display: block; margin-top: 6px; color: var(--fg-dim); }
```

- [ ] **Step 4: Typecheck**

Run (in `packages/fez-desktop`): `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/HireProposalCard.tsx packages/fez-desktop/src/App.tsx packages/fez-desktop/src/App.css
git commit -m "the proposal card: @fez's market suggestion renders as reasoning + record + price + a human button; 'open the hire' lands in the guest DM with the task drafted — the send and the money stay human acts"
```

---

### Task 7: outcome hooks in the guest DM

**Files:**
- Modify: `packages/fez-desktop/src/guest-threads.tsx` — two touches: (a) in `send()` (~line 392, after the task event is published and its id known), (b) where results arrive (the `resultRoots` / `KIND_RESULT` handling — grep `resultRoots.has`).

**Interfaces:**
- Consumes: `latestPendingFor`, `updateRecord`, `tauriStore` (Task 4).
- Produces: orchestration records gain `sentTaskId` when the drafted task is sent, and `outcome.delivered` when its result lands.

- [ ] **Step 1: Hook the send** — after `send()` obtains the published event id (grep how it builds/publishes the 47001; the signed event's `id` is in scope), append best-effort:

```ts
    // Orchestration corpus: if @fez proposed this hire, the send closes
    // the "accepted" loop with the real task id. Best-effort — a log
    // failure must never look like a failed send.
    void latestPendingFor(tauriStore.read, guest.pk)
      .then((rec) => rec && updateRecord(tauriStore.read, tauriStore.write, rec.id, { sentTaskId: sentEventId }))
      .catch(() => {});
```

(`sentEventId` = whatever local name holds the published task event's id; copy the real variable name.)

- [ ] **Step 2: Hook the result** — where a `KIND_RESULT` from `guest.pk` is first seen for one of `myTaskIds` (the same place `resultRoots` is built or consumed), append best-effort:

```ts
    void latestPendingFor(tauriStore.read, guest.pk)
      .then((rec) => {
        if (!rec?.sentTaskId || rec.outcome) return;
        if (rootId !== rec.sentTaskId) return; // only the proposed task closes the record
        const latencyS = Math.max(0, Math.round(Date.now() / 1000 - sentAtSec));
        return updateRecord(tauriStore.read, tauriStore.write, rec.id, { outcome: { delivered: true, latencyS } });
      })
      .catch(() => {});
```

(`rootId` / `sentAtSec` = the result's root task id and that task's created_at, both already known where results are processed; copy the real names. If `sentAtSec` is not conveniently in scope, omit `latencyS` — `delivered` is the load-bearing field.)

- [ ] **Step 3: Typecheck, imports**

Add `import { latestPendingFor, updateRecord, tauriStore } from "./orchestration";` to guest-threads.tsx.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/fez-desktop/src/guest-threads.tsx
git commit -m "guest DM closes the orchestration loop: the drafted task's send fills sentTaskId, its result fills outcome.delivered — the corpus row completes without ceremony"
```

---

### Task 8: @fez's prompt contract + tool attachment

**Files:**
- Modify: `packages/fez-desktop/src/welcome-core.ts:87` (`buildFezPersonaMd`)
- Test: extend whichever existing test covers `buildFezPersonaMd` (grep `buildFezPersonaMd` in `packages/fez-evals/tests`; if none asserts body text, add one to `packages/fez-evals/tests/onboarding-steps.test.ts`'s file or a sibling).

**Interfaces:**
- Produces: new @fez personas carry the market paragraph and `mcpServers: [bazaar]` so the bridge's tools (`bazaar_ask`, `market_directory`) attach at spawn.

- [ ] **Step 1: Write the failing test**

```ts
import { buildFezPersonaMd } from "../../fez-desktop/src/welcome-core";

it("@fez knows the market is a fallback, not a first resort", () => {
  const md = buildFezPersonaMd("pi");
  expect(md).toContain("market_directory");
  expect(md).toContain("fez-hire-proposal");
  expect(md).toContain("AT MOST ONE");
  expect(md).toMatch(/mcpServers:.*bazaar/);
});
```

- [ ] **Step 2: Run to verify it fails**, then **Step 3: implement** — in `buildFezPersonaMd`, add `bazaar` to the `mcpServers` frontmatter list (read the current builder; it already writes `aliases: [orchestrator]` — follow its list syntax), and append to the body (verbatim, this is the spec's prompt contract):

```
When a task needs a capability nobody on the roster claims — or the user
explicitly asks for the market — call market_directory, pick AT MOST ONE
candidate you would stake your name on, and reply with a fenced
fez-hire-proposal block:

```fez-hire-proposal
{ "task": "<the work, stated so a stranger could do it>",
  "pk": "<its 64-hex pubkey>", "name": "<its name>",
  "why": "<the roster gap, in one sentence>",
  "kind": "settle", "price_est_tao": 0.0, "rate_tao_hr": 0.0 }
```

The block renders as a card; the human decides. Never present market
answers as your own, never propose more than one candidate, and if the
roster covers the task, do not mention the market at all.
```

(Escape the inner fence properly for the template string — use a fence of four backticks in the persona body, or indent; check how the existing body text handles literal backticks.)

- [ ] **Step 4: Run tests** — the new assertion plus the full desktop-adjacent suite: `npx vitest run packages/fez-evals/tests` — Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/welcome-core.ts packages/fez-evals/tests/<the test file>
git commit -m "@fez's prompt contract: the market is a fallback, one candidate max, proposals as fez-hire-proposal blocks; bazaar tools attach via mcpServers"
```

---

### Task 9: end-to-end gate (live, on this Mac)

**Files:** none new — staging and verification.

- [ ] **Step 1: Stage the bazaar bridge** (the new tool) into `~/.fez`:

```bash
cd /Users/ken/Projects/Fez/fez-bazaar && npm run build:ext
cp dist/bridge.js ~/.fez/packages/bazaar/dist/bridge.js
cp dist/bridge.js ~/.fez/bin/fez-bazaar-ask 2>/dev/null || true  # only if ~/.fez/bin has it
```

- [ ] **Step 2: Retrofit the live @fez persona** — `~/.fez/personas/fez.md` predates the builder change; add `bazaar` to its `mcpServers` frontmatter and append the Task-8 paragraph to its body (hand edit; existing installs don't re-run onboarding).

- [ ] **Step 3: Build + install the app** (version bump per Global Constraints, kill-then-swap, verify timestamp):

```bash
cd /Users/ken/Projects/Fez/fez/packages/fez-desktop
# bump version in package.json + src-tauri/tauri.conf.json first
npm run tauri build
osascript -e 'quit app "fez"'; sleep 1; pkill -f "fez.app/Contents/MacOS/fez-desktop"; sleep 2
rm -rf /Applications/fez.app && ditto src-tauri/target/release/bundle/macos/fez.app /Applications/fez.app
ls -la /Applications/fez.app/Contents/MacOS/fez-desktop   # timestamp must be now
open /Applications/fez.app
```

- [ ] **Step 4: The spec's gates, run by hand:**

1. Ask @fez something the roster covers (e.g. writing, if quill's around): expect NO market mention.
2. Ask @fez for something nobody local claims ("I need research with named citations on X"): expect one `fez-hire-proposal` card naming a candidate, a why, and a price.
3. Click **not now** on one proposal → `extension_storage_read` the "orchestration" blob (or read `~/.fez/extension-data/orchestration.json`) → record shows `decision: "declined"`.
4. Trigger another proposal, click **open the hire** → guest DM opens with the task drafted → press send → agent answers → the record shows `decision: "accepted"`, `sentTaskId`, and `outcome.delivered: true`.
5. Pay through the DM strip (settle or lease) — confirm money moved only from this click path, and the burn vault took its 2%.

- [ ] **Step 5: Commit any fixups, then stop.** Publishing (`@fezchat/bazaar` patch for the bridge tool) and pushing wait for Ken's explicit go, per the test-before-push rule.

---

## Self-Review

- **Spec coverage:** directory tool (T1–2) ✓; proposal block + card + button (T3, T6) ✓; clicker's-wallet execution via DM (T5–6; no new payment code) ✓; prompt contract incl. fallback + one-candidate (T8, gated in T9.4) ✓; orchestration record with decision/outcome incl. declines (T4, T6, T7) ✓; failure honesty rides existing DM/wallet surfaces (noted in T6 title text; no new code needed) ✓; local-only data (T4 storage) ✓.
- **Spec deviation, deliberate:** spec says `~/.fez/orchestration.jsonl`; the plan stores `{records: []}` via extension-storage instead — same locality, zero new Rust. The spec's intent (local, append-ish, exportable later) is preserved; noted here so the deviation is chosen, not drifted into.
- **Placeholder scan:** the "copy the real variable name" notes in T5/T7 are deliberate read-the-file instructions with exact grep targets, not TBDs; all code blocks are complete.
- **Type consistency:** `HireProposal.kind` ("settle"|"lease"|"escrow") flows T3→T6; `OrchestrationRecord` field names match between T4's interface and T6/T7 call sites; `openGuestDm`'s `draft` matches T5's type and T6's call.
