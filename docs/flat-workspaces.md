# Flat workspaces: the relay is the community

**Status:** scoped, not started. Supersedes the open half of #103.

## The shape we want

A relay *is* a workspace. "Raleigh, NC" is a relay with `#food`, `#sports`,
`#weather` in it, and people talking. You add a relay the way you join a Slack
workspace; you switch channels inside it. Two levels, not three.

That is the model this document moves fez to.

## What is true today

fez has three levels — relay → communities → channels — because a community is
its own signed event (kind 47100) that lives *on* a relay. One relay can hold
many. Measured on the actual relays:

```
ws://localhost:7777             5 communities, 7 channels
  Home           id=4f2320df  creator=4d9a4f80
  Home           id=cfb88ff9  creator=4d9a4f80     <- same creator
  Home           id=a5cf2a2f  creator=4d9a4f80     <- same creator
  Home           id=b96e2222  creator=5dfdb2d0
  Web3Builders   id=e48f7904  creator=4d9a4f80

wss://67-205-188-204.sslip.io   2 communities, 2 channels
  Home             id=74032d6c  creator=3c1fa4a6
  Live Gate Test   id=1abf30b4  creator=22e579c1
```

Two things this shows:

1. **Onboarding mints a new "Home" every run.** Three of them, one creator. It
   never looks for the Home that already exists. The community layer is
   generating garbage rather than structure.
2. **A relay genuinely hosts unrelated groups.** The DO box has two communities
   from two different creators. Flattening gives that up — see *What this
   costs*.

The relay itself is chosen globally, by a single value:

```ts
// packages/fez-desktop/src/SettingsPane.tsx
const [relay, setRelay] = useState(localStorage.getItem("fez-relay") ?? "ws://localhost:7777");
localStorage.setItem("fez-relay", relay.trim());
```

Editing that field **replaces** your world. Everything — profile, memberships,
channels, messages — is addressed relative to a relay set that just changed, so
the app comes up connected and empty. Nothing is deleted; you moved. This is
what made a real user believe he had lost his account.

## Who signs what

A signature proves *which key wrote this* and *that nobody edited it since*.
Nothing more. References between events (message → channel, membership →
person) are foreign keys, but no database enforces them — so the question is
always **whose signature counts for which claim**.

| claim | settled by |
|---|---|
| "this message is from Douglas" | Douglas's key — never in doubt |
| "#food exists" | the workspace owner |
| "Douglas may read #food" | the workspace owner |

Two possible owners, and the choice is independent of how flat the structure is:

- **The relay is the owner** (Buzz). The relay signs the roster itself — kind
  13534, relay-signed, published after each add/remove. Whoever runs the box
  decides who is in.
- **A person is the owner** (fez today). A key signs membership; the relay is
  dumb pipe. If the relay turns hostile you move hosts and the roster still
  holds.

**We keep person-signed ownership.** Flattening the structure does not require
handing authority to the relay, and that authority is what #70, #74 and the
author gate exist to keep away from it.

## The model

**One relay = one workspace, owned by a key the relay advertises.**

- The relay's NIP-11 information document names its `owner` pubkey (Buzz
  already uses NIP-11 this way for the workspace icon via kind 9033, so the
  mechanism is proven in the wild).
- That owner key signs the channel list and the memberships.
- Channels belong to the relay. There is no community event.
- Ownership stays portable: move Raleigh to a new host, keep the owner key, and
  the workspace is the same workspace.

## Wire changes

| kind | today | after |
|---|---|---|
| 47100 community | creator-signed, `["d", communityId]` | **retired** |
| 47101 channel | `["d", channelId]`, `["c", communityId]` | owner-signed, drop `c` |
| 47102 membership | `["d", channelId]`, `["c", communityId]`, `["p", pk, role]` | owner-signed, drop `c` |
| 47103 message | `["h", channelId]`, `["c", communityId]` | drop `c` |
| NIP-11 doc | — | gains `owner` (hex pubkey) |

The `c` tag is the foreign key to a row that stops existing. Every filter,
publish path and cache key that carries `communityId` loses it.

## Client changes

- **`Community` disappears from `community-state.ts`.** Channels hang off the
  connection. `Scope` becomes just `channelId`.
- **Settings grows a relay list** — the workspace rail. You *add* relays; the
  active one is a selection. Switching never discards, which is the actual fix
  for the Douglas bug.
- **Profile becomes per relay.** Slack works this way (different name per
  workspace) and so does Buzz — `readSelfProfileCache(relayUrl, pubkey)`.
  Landing on a relay with no kind:0 for you should *prompt for a name*, not
  render you as a stranger. Do not auto-republish your profile onto every relay
  you touch; that pushes your identity somewhere you may not want it.
- **Onboarding stops creating anything.** Adding a relay joins the workspace.
  No Home is minted, so no Home can be duplicated.

## Blast radius

Measured, not estimated:

```
communityId          530 occurrences, 40 files, 12 packages
KIND_COMMUNITY/47100  17 occurrences outside src/kinds.ts
```

Heaviest: `fez-desktop` (15 files), then `fez-polls`, `fez-communities`,
`fez-live-blocks`, `fez-kanban`, `fez-client` (2–3 each). Extensions carry
`communityId` through their own APIs, so the extension API surface changes too
— which means installed extensions break and need a version bump.

## Migration — not needed

Decided during the build: the existing data is test data and is being
abandoned rather than converted. No migration script exists, and none
should be written.

What that means in practice:

- Old-model events (47100 communities, `c`-tagged channels, per-channel
  47102 rosters) are simply **ignored** by the new code — they are
  unowned relative to the relay's NIP-11 `owner`, so nothing absorbs
  them. They sit inert in the store.
- A relay coming to the flat model needs two things: an `--owner`, and
  someone to claim it (`claimWorkspace`), which publishes the first
  channel and a roster.
- Until a relay has an owner, it reports itself as an unclaimed
  workspace rather than looking empty — the honest state.

If a future relay ever does hold data worth keeping, the conversion is
mechanical (rewrite 47101/47102 owner-signed without `c`; messages
already carry `h` and need nothing), but it is not built.

## What this costs

- **A relay can no longer host two unrelated groups.** The DO box does this
  today. Running one relay per workspace is cheap on a small droplet, but it
  stops being free.
- **Installed extensions break** on the API change.
- **It is a wide, mechanical change** — 530 call sites — with real risk of a
  half-migrated state. It should land behind a version fence, not incrementally.

## Phases

1. **Relay + protocol.** NIP-11 `owner`, owner-signature verification in
   fez-relay's ingest policy, kinds registry updated. Evals for "an event
   signed by a non-owner claiming to create a channel is rejected".
2. **Client core.** `@fez/client` drops `Community`; `Scope` becomes
   `channelId`. This is where most of the 530 live.
3. **Migration script** with a dry run, then run it on both relays.
4. **GUI.** Workspace rail in settings, per-relay profile, onboarding that adds
   instead of creates.
5. **Extensions.** Bump the API, update the six that carry `communityId`.

Phases 1–3 are the protocol change and must land together. 4 and 5 can follow.

## Open questions

- **Who owns a relay that nobody configured?** A fresh `fez-relay` with no
  `owner` in NIP-11 — open workspace where anyone can make a channel, or
  refuse to serve until an owner is set?
- **Can ownership transfer?** A signed hand-off event, or is it a relay-config
  change only?
- **What happens to `Home`?** Under the flat model the personal scratch space
  isn't a community — it may want to be a local-only channel with no relay at
  all.
- **DMs are already community-free** (NIP-17 gift wraps, addressed to keys).
  They should be unaffected — confirm before phase 2.
