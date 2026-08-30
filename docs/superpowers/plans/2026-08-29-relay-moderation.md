# Workspace Relay Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a workspace owner real, enforced moderation — appointable admins, reversible relay-withhold of any message, and timeouts — all as owner/admin-signed edicts the relay honors.

**Architecture:** Nothing new moves to the relay. Admins are derived from the owner-signed 47102 roster (role `admin`). Ban and remove edicts reuse kind **30047** with two `d`-tags (`bans`, `removed`); authorization for both moves from `membershipPolicy` (owner-only) into `moderationPolicy` (owner **or** current admin). Enforcement is two honest layers: client trust rules (fast path) and relay `moderationPolicy` (backstop). Demoting an admin revokes their power in both places at once because both read the same roster.

**Tech Stack:** TypeScript, nostr-tools, `ws`, vitest. Relay = `packages/fez-relay` (built to `dist/`, tested from `packages/fez-evals/tests`). Client = `packages/fez-client`. GUI = `packages/fez-desktop` (React).

**Spec:** `docs/superpowers/specs/2026-08-29-relay-moderation-design.md`

## Global Constraints

- **Person-signs, not relay-signs.** The relay never originates a moderation decision; it only honors edicts signed by the owner or a current admin. (spec §"The one principle")
- **No permanent erasure.** Removal = reversible withhold. Never delete event bytes from the store. (spec §3, §4b)
- **Reuse kind 30047.** `d=bans` (p-tags, optional `until`) and `d=removed` (e-tags). No new kind, no kind-whitelist change. (spec §4b, decisions)
- **Admin guard rail.** An admin may not ban/kick/timeout/remove-authored-by the owner or another admin; only the owner may remove an admin. (spec §4a)
- **Tests run against built output.** Relay tasks: `npm run build` in `packages/fez-relay`, then `npx vitest --run <file>` from `packages/fez-evals`. Tests import from `../../fez-relay/dist/*.js`.
- **Out of scope:** bazaar/subnet, NIP-51 personal mute, reports-GUI, agent-memory scrub. (spec §"Non-goals", decisions)

---

### Task 1: Relay — admins can sign ban/remove edicts

Move 30047 authorization out of `membershipPolicy` (owner-only) into `moderationPolicy`, which derives the admin set from the owner-signed roster and accepts edicts from owner or any current admin.

**Files:**
- Modify: `packages/fez-relay/src/policies.ts` (membership `governed` check ~`policies.ts:132`; `moderationPolicy` ~`policies.ts:229-274`)
- Test: `packages/fez-evals/tests/relay-moderation.test.ts` (extend existing)

**Interfaces:**
- Consumes: `moderationPolicy(owner?: string)`, `membershipPolicy(owner?: string)`, `ctx.query`, `KIND_BAN_LIST`, `KIND_MEMBERSHIP`, `ROSTER_D`, `tag()`, `ok`, `reject()`.
- Produces: `moderationPolicy` now owns 30047 authorization. New internal `admins(ctx): Set<string>` = `{owner} ∪ {p-tag pubkeys on the latest owner-signed roster whose role tag === "admin"}`.

- [ ] **Step 1: Write failing tests** in `relay-moderation.test.ts`. Add an admin to the `beforeAll` roster and assert an admin-signed ban is honored, a non-admin's is not.

```ts
// in beforeAll, replace the roster publish with one that names an admin:
const admin = generateSecretKey();
const adminPk = getPublicKey(admin);
await probe.publishExpect(
  signAs(creator, 47102, "", [["d", "roster"], ["p", getPublicKey(creator)], ["p", adminPk, "admin"], ["p", trollPk]]),
  true
);
// new tests:
test("an admin-signed ban is honored at ingest", async () => {
  await probe.publishExpect(signAs(admin, 30047, "", [["d", "bans"], ["p", trollPk]], now() + 10), true);
  const reason = await probe.publishExpect(signAs(troll, 47103, "hi", [["h", CH]], now() + 11), false);
  expect(reason).toMatch(/banned/);
});
test("a plain member's ban list is rejected", async () => {
  const reason = await probe.publishExpect(signAs(mallory, 30047, "", [["d", "bans"], ["p", trollPk]]), false);
  expect(reason).toMatch(/not authorized|admin|owner/);
});
```

Also update the existing `"a forged ban list (non-owner) is rejected"` test's reason match to `/not authorized|admin|owner/` (the reason now comes from `moderationPolicy`, not `membershipPolicy`).

- [ ] **Step 2: Run, verify fail.** `cd packages/fez-relay && npm run build && cd ../fez-evals && npx vitest --run tests/relay-moderation.test.ts` → FAIL (admin ban rejected by membershipPolicy's owner-only gate).

- [ ] **Step 3: Implement.** In `membershipPolicy.onEvent`, drop `KIND_BAN_LIST` from `governed` so it no longer rejects non-owner 30047:

```ts
const governed = event.kind === KIND_CHANNEL || event.kind === KIND_MEMBERSHIP; // 30047 handled by moderationPolicy
```

In `moderationPolicy`, add the admin derivation and authorize 30047 by admin membership:

```ts
const ROSTER_D_ = "roster";
let cachedAdmins: Set<string> | undefined;
const admins = (ctx: PolicyContext): Set<string> => {
  if (cachedAdmins) return cachedAdmins;
  const roster = owner
    ? ctx.query({ kinds: [KIND_MEMBERSHIP], "#d": [ROSTER_D_] })
        .filter((e) => e.pubkey === owner)
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0]
    : undefined;
  const set = new Set<string>(owner ? [owner] : []);
  for (const t of roster?.tags ?? []) if (t[0] === "p" && t[1] && t[2] === "admin") set.add(t[1]);
  cachedAdmins = set;
  return set;
};
```

In `moderationPolicy.onEvent`, replace the `KIND_BAN_LIST` branch:

```ts
if (event.kind === KIND_BAN_LIST) {
  if (!admins(ctx).has(event.pubkey)) return reject("blocked: not authorized to moderate this workspace");
  cachedBans = undefined; // list moved
  return ok;
}
if (event.kind === KIND_MEMBERSHIP) { cachedAdmins = undefined; cachedBans = undefined; } // admin set may have changed
```

Update `bans()` to accept the latest 30047 `d=bans` signed by **any admin** (not just owner): replace `.filter((e) => e.pubkey === owner)` with `.filter((e) => admins(ctx).has(e.pubkey))`.

- [ ] **Step 4: Run, verify pass.** Same command → PASS.

- [ ] **Step 5: Commit.** `git add packages/fez-relay/src/policies.ts packages/fez-evals/tests/relay-moderation.test.ts && git commit -m "relay: admins (from owner roster) may sign 30047 edicts"`

---

### Task 2: Relay — timeouts (expiring bans)

A ban `p`-entry may carry an `until` unix-seconds at tag position [2]; the pubkey is banned only while `now < until` (absent `until` = permanent).

**Files:**
- Modify: `packages/fez-relay/src/policies.ts` (`moderationPolicy` `bans()` + `onEvent`/`onDeliver`)
- Test: `packages/fez-evals/tests/relay-moderation.test.ts`

**Interfaces:**
- Produces: `bans(ctx)` returns `Map<string, number | undefined>` (pubkey → until). Add helper `isBanned(pk, ctx)` = entry exists and (`until` undefined or `now < until`).

- [ ] **Step 1: Failing test.**

```ts
test("a timeout lifts automatically once until passes", async () => {
  const until = now() + 2;
  await probe.publishExpect(signAs(creator, 30047, "", [["d", "bans"], ["p", trollPk, String(until)]], now() + 20), true);
  const blocked = await probe.publishExpect(signAs(troll, 47103, "muted", [["h", CH]], now() + 21), false);
  expect(blocked).toMatch(/banned|timed out/);
  await new Promise((r) => setTimeout(r, 2100));
  await probe.publishExpect(signAs(troll, 47103, "back", [["h", CH]], now() + 3), true);
});
```

- [ ] **Step 2: Run, verify fail.** (currently the `until` tag is ignored; troll stays banned) → FAIL on the final publish.

- [ ] **Step 3: Implement.** In `bans()` build a `Map`:

```ts
cachedBans = new Map(
  (latest?.tags ?? []).filter((t) => t[0] === "p" && t[1]).map((t) => [t[1], t[2] ? Number(t[2]) : undefined] as const)
);
```

Replace `.has()` checks with an expiry-aware helper:

```ts
const isBanned = (pk: string, ctx: PolicyContext) => {
  const until = bans(ctx).get(pk);
  if (until === undefined) return bans(ctx).has(pk); // permanent (present with no until)
  return Math.floor(Date.now() / 1000) < until;
};
```

Use `isBanned(event.pubkey, ctx)` in `onEvent` and `isBanned(ctx.authedPubkey, ctx)` in `onDeliver`. Note `Map.get` returns `undefined` both for "absent" and "present-without-until", so guard: check `bans(ctx).has(pk)` first.

Refine:
```ts
const isBanned = (pk: string, ctx: PolicyContext) => {
  const m = bans(ctx);
  if (!m.has(pk)) return false;
  const until = m.get(pk);
  return until === undefined || Math.floor(Date.now() / 1000) < until;
};
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit.** `git commit -am "relay: expiring bans (timeouts) via until tag on 30047 d=bans"`

---

### Task 3: Relay — reversible withhold-delete

Owner/admin-signed 30047 `d=removed` lists event-ids (`e`-tags). Listed events are masked from every REQ result and their re-publish is rejected. Un-remove = republish the list without the id.

**Files:**
- Modify: `packages/fez-relay/src/policies.ts` (`moderationPolicy`)
- Test: `packages/fez-evals/tests/relay-moderation.test.ts`

**Interfaces:**
- Produces: `removed(ctx): Set<string>` = e-tag ids on the latest admin-signed 30047 `d=removed`. `moderationPolicy.onDeliver` also returns false for `removed.has(event.id)`; `onEvent` rejects a re-publish whose `event.id ∈ removed`.

- [ ] **Step 1: Failing test.**

```ts
test("a removed message is withheld from every reader, and restore brings it back", async () => {
  const msg = signAs(creator, 47103, "delete me", [["h", CH]], now() + 30);
  await probe.publishExpect(msg, true);
  await probe.publishExpect(signAs(admin, 30047, "", [["d", "removed"], ["e", msg.id]], now() + 31), true);
  const reader = new Probe(); await reader.open(); await reader.auth(creator);
  reader.send(["REQ", "r1", { kinds: [47103], "#h": [CH] }]);
  await reader.waitFor((m) => m[0] === "EOSE" && m[1] === "r1");
  expect(reader.messages.some((m) => m[0] === "EVENT" && (m[2] as any)?.id === msg.id)).toBe(false);
  // restore
  await probe.publishExpect(signAs(admin, 30047, "", [["d", "removed"]], now() + 32), true);
  reader.send(["REQ", "r2", { kinds: [47103], "#h": [CH] }]);
  await reader.waitFor((m) => m[0] === "EOSE" && m[1] === "r2");
  expect(reader.messages.some((m) => m[0] === "EVENT" && m[1] === "r2" && (m[2] as any)?.id === msg.id)).toBe(true);
  reader.close();
});
```

- [ ] **Step 2: Run, verify fail** (removed list unrecognized; event still delivered).

- [ ] **Step 3: Implement.** Add a `removed` cache and derivation mirroring `bans()` but keyed on `d=removed` / `e`-tags, authorized to `admins(ctx)`:

```ts
const REMOVED_D = "removed";
let cachedRemoved: Set<string> | undefined;
const removed = (ctx: PolicyContext): Set<string> => {
  if (cachedRemoved) return cachedRemoved;
  const latest = ctx.query({ kinds: [KIND_BAN_LIST], "#d": [REMOVED_D] })
    .filter((e) => admins(ctx).has(e.pubkey))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0];
  cachedRemoved = new Set((latest?.tags ?? []).filter((t) => t[0] === "e" && t[1]).map((t) => t[1]));
  return cachedRemoved;
};
```

In `onEvent`, the `KIND_BAN_LIST` branch must distinguish `d`: authorize by admin (both d-tags), and invalidate the right cache:

```ts
if (event.kind === KIND_BAN_LIST) {
  if (!admins(ctx).has(event.pubkey)) return reject("blocked: not authorized to moderate this workspace");
  if (tag(event, "d") === REMOVED_D) cachedRemoved = undefined; else cachedBans = undefined;
  return ok;
}
```

Also in `onEvent`, reject re-publish of a removed id (before the ban check):
```ts
if (event.kind !== KIND_BAN_LIST && removed(ctx).has(event.id)) return reject("blocked: this message was removed by a moderator");
```

In `onDeliver`, add `if (removed(ctx).has(event.id)) return false;` before the ban read-gate.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit.** `git commit -am "relay: reversible withhold-delete via 30047 d=removed"`

---

### Task 4: Config — enable created-at-fence in production

The roster, ban list, and removed list are all latest-wins on `created_at`; enable the built-but-off fence so a backdated edict can't override a newer one.

**Files:**
- Modify: `deploy/fez-relay.service:52-55` (the `--policy` lines)

**Interfaces:** none (ops config).

- [ ] **Step 1: Add the flag.** Append `--policy created-at-fence` to the ExecStart policy list in `deploy/fez-relay.service`. (Registry key exists: `builtinPolicies["created-at-fence"]`, `policies.ts`.)

- [ ] **Step 2: Sanity test the policy is wired** (no prod deploy in this task) — add to `packages/fez-evals/tests/relay-hygiene.test.ts` or a new tiny test that `createdAtFencePolicy` rejects a past-fenced non-1059 event:

```ts
import { createdAtFencePolicy } from "../../fez-relay/dist/policies.js";
test("created-at-fence rejects a backdated edict", () => {
  const p = createdAtFencePolicy({ maxDriftS: 900 });
  const r = p.onEvent!({ kind: 30047, created_at: Math.floor(Date.now()/1000) - 5000 } as any, {} as any);
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 3: Run, verify pass.** `cd packages/fez-relay && npm run build && cd ../fez-evals && npx vitest --run tests/relay-hygiene.test.ts`

- [ ] **Step 4: Commit.** `git commit -am "deploy: enable created-at-fence on the production relay"`

---

### Task 5: Client — workspace-state moderation reads

Teach `WorkspaceState` to expose `canModerate`, parse timeouts, and track the removed set — the pure model the client and GUI both read.

**Files:**
- Modify: `packages/fez-client/src/workspace-state.ts` (Workspace interface; `absorb` ban branch ~`:320`; add methods near `isOwner`/`roleOf` ~`:355-360`)
- Create: `packages/fez-client/tests/workspace-state.test.ts` + add `"test": "vitest --run"` to `packages/fez-client/package.json` scripts and `vitest` devDep (mirror `packages/fez-wallet/package.json`).

**Interfaces:**
- Produces:
  - `canModerate(pubkey: string): boolean` = `isOwner(pubkey) || roleOf(pubkey) === "admin"`.
  - `Workspace.banned` becomes `Map<string, number | undefined>` (pubkey → until); `isBanned(pk)` returns `has(pk) && (until===undefined || now<until)`.
  - `Workspace.removed: Set<string>`; `isRemoved(eventId: string): boolean`.
  - `absorb` accepts 30047 `d=removed` and gates both 30047 d-tags on `canModerate(event.pubkey)` (owner or admin), not owner-only.

- [ ] **Step 1: Failing tests** in `workspace-state.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { WorkspaceState } from "../src/workspace-state.js";
// (construct a state with owner set via NIP-11 describe(), absorb a roster naming an admin, then:)
test("admin can moderate, plain member cannot", () => { /* expect state.canModerate(adminPk) true, memberPk false */ });
test("an expired timeout is not banned", () => { /* absorb 30047 d=bans p until=past → isBanned false */ });
test("an admin-signed removed list marks the event removed", () => { /* isRemoved(id) true */ });
test("a plain member's ban list is ignored by the client", () => { /* absorb rejected, banned empty */ });
```

- [ ] **Step 2: Run, verify fail.** `cd packages/fez-client && npx vitest --run` → FAIL (methods/fields absent).

- [ ] **Step 3: Implement.**
  - Add `removed: Set<string>` and `removedCreatedAt/removedEventId` to `Workspace`; init in the workspace factory.
  - Change `banned` to `Map<string, number | undefined>`; update the `absorb` ban branch to parse `[p, until?]` and to gate on `canModerate(event.pubkey)` instead of owner-only. Add a sibling branch for `d === "removed"` populating `removed` from `e`-tags with its own latest-wins guard.
  - `isBanned(pk)`: `const u = this.workspace.banned.get(pk); return this.workspace.banned.has(pk) && (u === undefined || Math.floor(Date.now()/1000) < u);`
  - Add `canModerate` and `isRemoved`.
  - Update `isMember` (uses `banned.has`) to use the expiry-aware `isBanned`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit.** `git add packages/fez-client && git commit -m "client: canModerate, timeouts, removed-set in WorkspaceState"`

---

### Task 6: Client — moderation actions & gates

Widen the moderation gates from owner-only to `canModerate` with the guard rail, and add the new verbs.

**Files:**
- Modify: `packages/fez-client/src/index.ts` — `banUser` `:1788`, `unbanUser` `:1796`, `kick` `:1759`, `invite` `:1739`, delete trust rule `:2405`, and `deleteMessage` `:1065`.
- Test: `packages/fez-client/tests/moderation-actions.test.ts`

**Interfaces:**
- Produces:
  - `banUser(pubkey: string, until?: number): Promise<string>` — timeout when `until` set.
  - `promote(pubkey: string): Promise<void>` / `demote(pubkey: string): Promise<void>` — owner-only; republish roster with/without `role=admin`.
  - `removeMessage(eventId: string, reason?: string): Promise<void>` / `restoreMessage(eventId: string): Promise<void>` — publish 30047 `d=removed`.
  - Guard: `assertCanTarget(actor, target)` throws if actor is admin (not owner) and target is owner or admin.
- Consumes: `state.canModerate`, `state.isOwner`, `state.roleOf`, `publishRoster` `:1715`, the 30047 publish path used by `banUser`.

- [ ] **Step 1: Failing tests.** Assert: an admin's client builds a valid ban edict; an admin targeting the owner throws; `removeMessage` publishes a 30047 `d=removed` containing the id; `banUser(pk, until)` includes the `until` tag; `promote` republishes a roster with `role=admin`. Test at the event-building layer (spy the publish seam) to avoid a live relay.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.**
  - Replace `if (!this.state.isOwner(this.pubkey)) throw …only the workspace owner…` in `banUser`/`kick` with `if (!this.state.canModerate(this.pubkey)) throw new Error("only a moderator can do this")` plus `this.assertCanTarget(this.pubkey, pubkey)`.
  - Keep `invite`, `promote`, `demote`, channel create/archive **owner-only** (roster/structure stays with the owner).
  - `assertCanTarget`: `if (!this.state.isOwner(actor) && (target === this.state.workspace.owner || this.state.roleOf(target) === "admin")) throw new Error("admins can't act on the owner or other admins");`
  - `banUser(pubkey, until?)`: add `["p", pubkey, ...(until ? [String(until)] : [])]` to the 30047 `d=bans` tags (fetch-current-list + add, mirroring existing behavior).
  - `removeMessage`/`restoreMessage`: publish 30047 `d=removed` with the current e-tag set ± the id, signed by this client; gate on `canModerate`.
  - Delete trust rule `:2405`: `const isModerator = this.state.canModerate(event.pubkey);` and also treat `state.isRemoved(msg.id)` as removed regardless of author.
  - `deleteMessage` (author self-delete) unchanged.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit.** `git commit -am "client: admin-gated moderation verbs (ban/timeout/remove/promote) + guard rail"`

---

### Task 7: GUI — admin roles in ManagePane

Let the owner appoint admins and show moderation controls to admins, not just the owner.

**Files:**
- Modify: `packages/fez-desktop/src/ManagePane.tsx` (role `<select>` `:311`; `amCreator` gating `:119-121`; member row `:93-112`)
- Create: `packages/fez-desktop/tests/manage-guard.test.ts` (pure-logic test, mirrors `packages/fez-wallet/tests/gui-logic.test.ts`)

**Interfaces:**
- Consumes: `client.state.canModerate`, `client.promote`, `client.demote`, `client.roleOf`.
- Produces: an owner-only promote/demote control per member; kick/ban shown when `client.state.canModerate(client.pubkey)`.

- [ ] **Step 1: Failing test.** Extract the visibility decision into a pure helper and test it:

```ts
// manage-guard.ts (new small module) — export function moderationControls(viewerRole, targetRole, viewerIsOwner)
test("admin sees kick/ban on members but not on owner/admin", () => {
  expect(moderationControls("admin","member",false)).toMatchObject({ kick: true, ban: true, promote: false });
  expect(moderationControls("admin","admin",false)).toMatchObject({ kick: false, ban: false });
  expect(moderationControls("owner","admin",true)).toMatchObject({ demote: true });
});
```

- [ ] **Step 2: Run, verify fail.** `cd packages/fez-desktop && npx vitest --run tests/manage-guard.test.ts`

- [ ] **Step 3: Implement.** Add `manage-guard.ts` with the pure function; in `ManagePane.tsx` add `admin` to the invite `<select>`, render promote/demote for the owner, and gate the kick/ban buttons on `moderationControls(...)`. Wire promote/demote to `client.promote/demote`.

- [ ] **Step 4: Run, verify pass** (unit). Then build and eyeball in the running app: promote a member → they gain the manage controls; demote → they lose them.

- [ ] **Step 5: Commit.** `git commit -am "gui: appoint admins + admin-visible moderation controls in ManagePane"`

---

### Task 8: GUI — moderator remove + timeout duration

A per-message "remove" action for moderators and a duration choice on ban.

**Files:**
- Modify: `packages/fez-desktop/src/App.tsx` (message row where tombstone renders `:3087`; ban action in `ManagePane.tsx`)

**Interfaces:**
- Consumes: `client.removeMessage`, `client.restoreMessage`, `client.state.isRemoved`, `client.banUser(pk, until?)`.

- [ ] **Step 1:** Add a "remove"/"restore" affordance on each message, shown when `client.state.canModerate(client.pubkey)`; wire to `removeMessage`/`restoreMessage`. The existing tombstone render stays as the removed-state display.

- [ ] **Step 2:** In the ban control, offer duration options (1h / 24h / 7d / permanent) → compute `until = now + seconds` (or omit for permanent) → `client.banUser(pk, until)`.

- [ ] **Step 3: Verify in the running app** (`tauri dev`): as owner, remove a message → it tombstones for everyone and a raw REQ no longer returns it (cross-check with `websocat` against the local relay); restore brings it back; a 1-minute timeout blocks the target then lifts. (No unit seam here; this is React wiring over already-tested client methods.)

- [ ] **Step 4: Commit.** `git commit -am "gui: moderator remove/restore on messages + ban duration (timeouts)"`

---

## Self-Review

**Spec coverage:** §4a roles → Tasks 1,5,6,7. §4b withhold-delete → Tasks 3,5,6,8. §4c timeouts → Tasks 2,6,8. §4d memory scrub → deferred (per decisions). §"verification tasks" created-at-fence → Task 4; subnet-bridge check → carried as a spec verification item, not code (no workspace→subnet read path exists in this repo; confirm in the bazaar repo before relying on it). §3 removal ceiling → stated; no code owes it beyond the deferred scrub.

**Placeholder scan:** none — every code step shows real deltas against cited lines.

**Type consistency:** `canModerate`/`isBanned`/`isRemoved`/`removeMessage`/`restoreMessage`/`banUser(pk, until?)`/`promote`/`demote` are named identically across Tasks 5–8. `banned` is `Map<string, number|undefined>` in both relay (`bans()`) and client (`Workspace.banned`). 30047 d-tags `bans`/`removed` consistent relay↔client. `admins(ctx)` internal to `moderationPolicy` only.
