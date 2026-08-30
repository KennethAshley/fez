# Moderation UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace fez's cryptic inline moderation glyphs with the discoverable, decentralization-honest surfaces in the approved mockup: a two-plane **user card**, a labeled **message menu**, inline **role badges**, reasons carried **inside the signed edict**, a **personal mute** plane, and a shared **moderation queue**.

**Architecture:** The enforcement backend already exists and is tested (relay `moderationPolicy`, client `promote/demote/kick/banUser(until?)/removeMessage/restoreMessage`, guard rail). This plan is mostly a **GUI layer** over those methods, plus three protocol extensions: a reason field on 30047 edicts, a client-side NIP-51 mute list, and multi-moderator report encryption + shared resolution. Reuse the app's existing `menuItem()` labeled-menu and `ReactionPicker` positioned-popover patterns.

**Tech Stack:** React (`packages/fez-desktop`), TypeScript client (`packages/fez-client`), TS relay (`packages/fez-relay`), vitest. Design source: the approved mockup (artifact 3449c7d2) + `docs/superpowers/specs/2026-08-29-relay-moderation-design.md`.

## Global Constraints

- **Person-signs.** Authority actions are owner/admin-signed edicts; personal mute is client-side, never signed, never enforced by roster/relay.
- **Honest copy.** "Removed" not "deleted forever"; "ban from this workspace" not global ban; the relay withholds, it can't erase.
- **Two planes, never blurred.** Authority (red, everyone) vs personal (teal, you only) are visually and verbally distinct everywhere.
- **Reuse existing patterns:** `menuItem(label, glyph, onClick)` (App.tsx:2951) for menus; `ReactionPicker` (App.tsx:2660, `at:{x,y}`+`onClose`) for popovers; `client.state.roleOf/canModerate/canModerateMessage`.
- **Reports route to all moderators** — owner (by default, can opt out) + every admin.
- Tests: relay via `packages/fez-evals/tests` against built `dist`; client/desktop via `vitest --run` (`../../node_modules/.bin/vitest` in desktop).

---

## Slice 1 — The user card (discoverability centerpiece)

A positioned popover opened by clicking an avatar or name, with the two-plane labeled action list. Uses only already-built client methods; personal mute is present but wired in Slice 4.

### Task 1.1: UserCard component (pure render + guard logic)

**Files:**
- Create: `packages/fez-desktop/src/UserCard.tsx`
- Create: `packages/fez-desktop/src/user-card-actions.ts` (pure: which actions show)
- Test: `packages/fez-desktop/tests/user-card-actions.test.ts`

**Interfaces:**
- Produces `cardActions(viewerRole, targetRole, viewerIsOwner, targetIsSelf): { makeAdmin, removeAdmin, timeout, kick, ban, mute }` (booleans). Reuses the guard rail from `manage-guard.ts` (`moderationControls`) and adds `mute: !targetIsSelf` (personal, always available on others).
- `UserCard({ pk, at, client, onClose })` — positioned like `ReactionPicker`.

- [ ] **Step 1: Failing test** for `cardActions`: admin sees make-admin+timeout+kick+ban+mute on a member; none of the authority actions on another admin; mute on anyone but self; owner sees demote on an admin.
- [ ] **Step 2: Run** `../../node_modules/.bin/vitest --run tests/user-card-actions.test.ts` → FAIL.
- [ ] **Step 3: Implement** `user-card-actions.ts` (compose `moderationControls` + mute rule).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** Build `UserCard.tsx`: header (Avatar size 40, name, `npub…` short via `pk.slice`, role badge, presence dot); an **Authority** group (`Make admin`/`Remove admin` → `client.promote/demote`; `Time out` → expands a preset ladder `5m/1h/1d/1w` computing `until=now+secs` → `client.banUser(pk, until)`; `Kick from workspace` → `client.kick`; `Ban from this workspace` → red, reveals an optional reason input then `client.banUser(pk, undefined, reason)` [reason param lands in Slice 3; call `client.banUser(pk)` until then]); a **Just for you** group (`Mute this person` → `client.mutePerson(pk)` [Slice 4; render disabled with tooltip "coming soon" until then]). Labels and colors from the mockup; wrap actions in `void run(...)`-style handlers with `onClose`.
- [ ] **Step 6: Commit** `git add packages/fez-desktop/src/UserCard.tsx packages/fez-desktop/src/user-card-actions.ts packages/fez-desktop/tests/user-card-actions.test.ts && git commit -m "gui: UserCard component + action guard logic"`

### Task 1.2: Open the card from avatars/names

**Files:** Modify `packages/fez-desktop/src/App.tsx` (message row Avatar/name ~ the `<Avatar>` + `.name` in the message component), `packages/fez-desktop/src/ManagePane.tsx` (member rows).

**Interfaces:** Consumes `UserCard`. Adds a `cardAt` state `{pk, x, y} | undefined`.

- [ ] **Step 1:** In the message row, make the Avatar and the `.name` span clickable → set `cardAt` from `e.currentTarget.getBoundingClientRect()`. Render `{cardAt && <UserCard pk={cardAt.pk} at={cardAt} client={client} onClose={()=>setCardAt(undefined)} />}`.
- [ ] **Step 2:** In `ManagePane` member rows, replace the inline `↑↓×⊘⏱` cluster (the `moderationControls` block) with a single `⋯`/click-row that opens the same `UserCard`. Keep the `banned` section + invite box.
- [ ] **Step 3: Verify in the running app** (`tauri dev`): click a member's face → card opens with labeled actions; promote/kick/ban/timeout work; guard rail hides disallowed actions.
- [ ] **Step 4: Commit** `gui: open the user card from avatars, names, and the manage pane`

---

## Slice 2 — Message menu + role badges

### Task 2.1: Moderator items in the message menu

**Files:** Modify `packages/fez-desktop/src/App.tsx` (the `menuItem` context menu ~2951–2961; the hover actions ~3003–3059; the tombstone ~3104).

- [ ] Add to the existing labeled context menu, when `client.canModerateMessage(msg)`: `menuItem("remove message", "⊘", () => client.removeMessage(msg.id))` (red styling). Move "report to community creator…" wording to `report to moderators` (Slice 5 makes it plural).
- [ ] Retire the bare hover `⊘` glyph (Slice 1/2 make the menu the home) — keep `⧉ ☺ ↩` and a single `⋯` that opens the context menu.
- [ ] Tombstone: keep the labeled `Restore` (already added), show reason once Slice 3 lands.
- [ ] **Verify in app**, then **commit** `gui: moderator remove lives in the labeled message menu`.

### Task 2.2: Inline role badges

**Files:** Modify `packages/fez-desktop/src/App.tsx` (message `who` row), reuse the `.badge` styles from `ManagePane`/App.css.

- [ ] Next to a message author's name, render a badge when `client.state.roleOf(pk)` is `owner`/`admin`/`bot` (owner=ember, admin=yellow, agent=teal), matching the mockup. Pure display.
- [ ] **Verify in app**, **commit** `gui: role badges next to names in chat`.

---

## Slice 3 — Reason inside the edict

**Files:** `packages/fez-client/src/index.ts` (`banUser`, `removeMessage`, `publishBanList`, `publishRemovedList`, absorb reason), `packages/fez-client/src/workspace-state.ts` (parse reason), `packages/fez-relay/src/policies.ts` (tolerate extra tag elements — already does), tests in both.

**Interfaces:**
- `banUser(pubkey, until?, reason?)`, `removeMessage(eventId, reason?)`.
- Ban tag becomes `["p", pk, until ?? "", reason ?? ""]` (positional; empty strings preserved); removed tag `["e", id, reason ?? ""]`.
- `WorkspaceState`: `banReason(pk): string | undefined`, `removalReason(id): string | undefined`.

- [ ] **Client test** (workspace-state): a ban with `["p", pk, "", "spam"]` → `banReason(pk)==="spam"`, still banned; removed with reason parses.
- [ ] Implement: extend the tag builders + absorb parsing (Maps hold `{until, reason}` / `Set`→`Map<id,reason>`); update `isBanned` (until at index 2), add reason getters.
- [ ] **Relay:** `bans()`/`removed()` ignore the extra element (verify existing tests still green; the `until` parse already reads index 2 — keep it).
- [ ] Wire `UserCard` ban reason field + tombstone reason display + banned-list reason.
- [ ] Tests green (relay + client), **verify in app**, **commit** `client+gui: reasons carried inside ban/remove edicts`.

---

## Slice 4 — Personal mute (NIP-51)

**Files:** `packages/fez-client/src/index.ts` (mute list + filter), `packages/fez-client/src/workspace-state.ts` or a dedicated store, tests; wire `UserCard` mute.

**Interfaces:**
- `mutePerson(pk)`, `unmutePerson(pk)`, `isMutedByMe(pk): boolean` — a self-authored NIP-51 kind-10000 mute list (per research), `p`-tags, published to the relay as the user's own account data (client-side authority only).
- The message stream and mention/notify paths skip authors where `isMutedByMe`.

- [ ] **Client test:** mute publishes a 10000 list with the pk; muted authors are filtered from `messagesByChannel` reads; unmute restores; personal — no roster/relay-policy involvement.
- [ ] Implement mute list load/publish + a filter applied at render/query. Never on the signed-edict path.
- [ ] Enable the `UserCard` "Mute this person" (remove the disabled stub); show "Unmute" when already muted.
- [ ] Tests green, **verify in app** (mute an agent → its messages vanish for you only), **commit** `client+gui: personal mute (NIP-51), the you-only plane`.

---

## Slice 5 — Moderation queue

**Files:** `packages/fez-client/src/index.ts` (`sendReport` to all mods, `listReports`, `resolveReport`), a new `packages/fez-desktop/src/ModerationQueue.tsx` full view + a nav entry, tests.

**Interfaces:**
- Report (kind 1984) reason NIP-44-encrypted **to each current moderator** (owner + admins) — one wrap per recipient, `p`-tagged; carries the target `e` (message) + author `p` + channel `h`.
- `listReports(): Report[]` — decrypts reports addressed to me (a moderator), groups by target message, newest first, excludes resolved.
- `resolveReport(target, action)` — a signed resolution marker (owner/admin) referencing the report target; every moderator's queue honors it → item drops with attribution ("removed by theo").
- `ModerationQueue` view: per-entry flagged message + reporters/reasons + actions (Jump / Remove / Ban author / Dismiss), Open/Resolved tabs, full-width.

- [ ] **Client tests:** report encrypts to owner+admins (N wraps); `listReports` decrypts + groups; `resolveReport` marker removes the item for a second moderator; a member (non-mod) cannot decrypt.
- [ ] Implement the multi-recipient report, the queue query/group/decrypt, and the resolution marker; move `App.tsx` `sendReport` onto the new multi-mod path.
- [ ] Build `ModerationQueue.tsx` (full view) + a nav entry (visible only to moderators); actions reuse `client.removeMessage/banUser` + `resolveReport`.
- [ ] Tests green, **verify in app**, **commit** `client+gui: shared moderation queue for flagged messages`.

---

## Self-Review

**Coverage:** user card → Slice 1; message menu + badges → Slice 2; reason-in-edict → Slice 3; personal mute → Slice 4; queue + all-moderator routing + shared resolution → Slice 5. Honest copy + two-plane split are Global Constraints applied throughout.

**Sequence rationale:** 1–2 are pure GUI over shipped methods (fastest visible win, no protocol risk); 3 is a small protocol extension the card/menu then display; 4 and 5 are the larger new protocol pieces. Each slice ends shippable and independently verifiable in the running app.

**Type consistency:** `banUser(pk, until?, reason?)`, `removeMessage(id, reason?)`, `cardActions(...)`, `mutePerson/unmutePerson/isMutedByMe`, `listReports/resolveReport` are named identically across slices. `UserCard`/`ModerationQueue` are the two new components; `user-card-actions.ts` composes the existing `manage-guard.ts`.
