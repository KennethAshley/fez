# Workspace relay moderation: admin roles, reversible withhold-delete, timeouts

**Status:** designed, not started.
**Scope:** the workspace relay (relay.fez.chat + self-hosted boxes). Not the bazaar/subnet relay.

## The one principle

Nothing in this design moves authority to the relay. The relay already honors
edicts signed by keys the workspace owner has blessed — that is exactly how the
30047 ban list works today (`moderationPolicy`, `policies.ts:235-272`). This
design teaches the relay two more things: who the *admins* are (derived from the
owner-signed roster, so still the owner's signature), and how to honor a *remove
this message* decree. The relay never decides anything on its own; it enforces
signed edicts from keys the owner authorized.

## What exists today (the starting point)

- **Roles are a type, not a mechanism.** `Role = owner | admin | member | bot`
  (`workspace-state.ts:22`), stored per-member in the 47102 roster, but every
  moderation gate checks `isOwner()` — never the role (`index.ts:1740,1760,1777`;
  `isModerator = isOwner` at `index.ts:2405`). The GUI role dropdown offers only
  `member`/`bot` (`ManagePane.tsx:278,311`). There is no way to appoint an admin.
- **Bans are real and relay-enforced.** Owner-signed 30047 `d=bans`; blocks
  writes and withholds reads at ingest (`policies.ts:235-272`).
- **Moderator-delete is client-tombstone only.** The relay honors NIP-09 kind-5
  only from the event's own author (`relay.ts:195,421`). A moderator "delete" is
  a client trust rule (`index.ts:2405`); the original 47103 stays in the store
  and is still served to any authed client — including a raw non-fez one.
- **No timeouts.** Bans are a flat set of pubkeys, no expiry.

## Non-goals (explicitly out of this plan)

- **Bazaar / subnet moderation.** Different relay, no roster, public-market trust
  model. Its relay runs its own pluggable policy stack; nothing here couples to
  it. A separate design in a separate repo if/when needed.
- **Permanent erasure / purge.** We never wipe bytes. Removal = reversible
  withhold (below). A destructive purge tool is not built and not required.
- **Personal mute / block (NIP-51).** "Hide from my own view" — per-user client
  state, no signing, no shared seams with owner-signed enforcement. Separate
  later item.
- **Reports-queue GUI.** The `/reports` inbox is TUI-only today; porting it to the
  desktop is a viewing surface, not enforcement. Separate later item.

## The removal ceiling (state it honestly)

Withhold-delete removes a message from the relay's serving and from compliant
clients going forward. It **cannot** erase copies that already left the relay:
client caches, agent memory, screenshots. This is the same limit Buzz has — even
its purge engine can't reach clients. "Delete" here means *the relay stops
serving it and honest clients honor the decree*, never *it is gone from the
universe*. The design owns this rather than implying otherwise, and adds one
best-effort mitigation for the agent-memory leak (see §4d).

## Design

### 4a. Admin roles

- **Grant.** The owner promotes/demotes a member from `ManagePane`: the role
  select gains an `admin` option, and existing members get a promote/demote
  control. Mechanically this republishes the 47102 roster with `role=admin` for
  that pubkey — the roster already carries a role per member, so nothing new goes
  on the wire. `invite()` already takes a role (`index.ts:1739`); widen the GUI
  and drop the `member|bot`-only restriction.
- **Enforce, client-side.** Replace the `isOwner()` checks on kick/ban/delete/
  timeout with `canModerate(pk) = isOwner(pk) || roleOf(pk) === "admin"`. Guard
  rail (mirrors Buzz `moderation_authz.rs:163`): an admin may not ban/kick/timeout
  the owner or another admin; only the owner may remove an admin.
- **Enforce, relay-side.** `moderationPolicy` already receives the owner-signed
  47102 roster. It derives the current admin set from it and accepts ban / delete
  / timeout edicts signed by the owner **or** any current admin. Demote an admin
  (owner republishes the roster without `role=admin`) and their edicts stop being
  honored automatically — no revocation list needed.

### 4b. Reversible withhold-delete

- **The decree.** An owner/admin-signed addressable "removed events" list, mirror
  of the 30047 ban list: entries are `e`-tags of removed event-ids plus an
  optional reason, latest-wins, same trust chain as the roster. (Exact kind number
  is a spec detail — proposal: a 300xx addressable event with `d=removed`,
  consumed by `moderationPolicy` the same way `d=bans` is.)
- **Relay enforcement.** `moderationPolicy` gains: (1) `onDeliver` masks any event
  whose id appears in a valid decree from a *current* owner/admin — withheld from
  every REQ result, including raw subscriptions; (2) `onEvent` rejects a
  re-publish of a removed id.
- **Reversible.** Un-delete = the owner/admin republishes the list without that
  id. The 47103 was never destroyed — it is served again immediately. This is the
  key answer to the "I don't want permanent deletion" concern.
- **Client.** Keeps rendering the honest tombstone ("⌫ removed by a moderator",
  `App.tsx:3087`) — but now it is the truth, because the relay actually withholds
  the content rather than trusting the client to hide it.

### 4c. Timeouts / temp-bans

A timeout is a ban with an expiry. Extend the 30047 ban entry with an optional
`until` timestamp; `moderationPolicy` treats a pubkey as banned only while
`now < until` (or always, if `until` is absent — that is a permanent ban).
One optional field on the seam we are already touching; no new event kind.

### 4d. Best-effort agent-memory scrub

When an agent's client observes a delete decree for content it has in memory, it
drops the matching memory entry, best-effort. This closes the obvious leak where
an agent keeps quoting a moderated message. Explicitly **not** a guarantee — see
the removal ceiling (§3). Flagged for review as optional; it touches the agent
memory tools and can be split to a follow-up if it bloats the first cut.

### 4e. Surfaces

- `ManagePane`: promote/demote to admin; kick/ban/timeout controls visible to
  admins, not only the owner; per-message "remove" action for moderators.
- The banned section already renders; add expiry display for timeouts.

## Enforcement lives in two honest places

- **Client trust rules** — the fast path; compliant clients honor edicts on sight.
- **Relay `moderationPolicy`** — the backstop; a non-compliant client can't bypass
  bans, withholds, or timeouts because ingest and delivery enforce them.

Both derive authority from the same owner-signed roster, so a demotion revokes an
admin's power in both places at once.

## Testing (the relay already has a policy harness)

- Admin-signed ban is honored; a demoted admin's ban is **not**.
- An admin cannot ban/kick/timeout the owner or another admin.
- A withheld event is absent from REQ for **every** client, including a raw
  subscription; un-deleting restores it.
- A decree from a non-admin member is ignored.
- A timeout blocks writes until `until`, then lifts automatically.
- A decree/roster backdated in `created_at` does not override a newer one
  (see verification tasks — enable `created-at-fence`).

## Verification tasks (before or during implementation)

1. **Subnet bridge check.** Confirm no bridge has the subnet reading
   *workspace*-relay events for scoring. If one exists, a withheld event could
   read as a miner going silent — a false signal. (Bazaar is a separate repo;
   this is a check, not a code change here.)
2. **Enable `created-at-fence`.** Roster, ban list, and the new removed-events
   list are all latest-wins on `created_at`. The `createdAtFencePolicy` is built
   but not enabled in production (`policies.ts:205-221` vs `fez-relay.service`).
   Turn it on so a backdated edict can't override a newer one.

## Decisions (were open questions)

- **Delete decree shape:** an addressable `d=removed` list, mirroring the 30047
  ban list. Chosen over per-event kind-5 — same trust chain, `moderationPolicy`
  already knows how to consume an owner/admin-signed addressable list.
- **Memory scrub (§4d):** split to a follow-up. Not in the first cut; the first
  cut is roles + withhold-delete + timeouts. The removal ceiling (§3) is stated
  regardless.
