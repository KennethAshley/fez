# GAPS — fez vs Buzz (the reference implementation)

A crate-by-crate audit of what Buzz has that fez doesn't, what fez has that's
thinner, and what fez deliberately skips. This is the standing
roadmap-against-reference: update it as gaps close.

- Audited: Buzz `8b8445f5e` (2026-08-14) against fez `701cb3f` (2026-08-15).
- **Update 2026-08-17 (evening)**: items 7 (read-side seam: NIP-42 +
  onDeliver + membership read gating, `f72ef07`), 9 in full (group DMs,
  `f993d65`), and 10 (fez-media/Blossom, `701e642`) also closed.
- **Update 2026-08-17**: roadmap items 1–6, 8, 16, and most of 9 closed in
  the overnight hardening pass (commits `1878cb1`…`3996a8f`) — reconnect,
  ingest hygiene, timeouts, deletion, trust-boundary tests + CI,
  compaction, session handoff, encrypted reminders, profiles, /status,
  roster removal. Closed items are marked ✅ below; their §2 sections stand
  as the historical rationale.
- Method: six parallel audits (agent runtime; relay/storage/scale;
  protocol/SDK/testing; auth/identity/admin; feature services; client
  surfaces + maturity), every Buzz crate read at source level and checked
  against fez code — not the docs.
- Scale context: Buzz is ~30 Rust crates (buzz-relay ~66k LOC, buzz-acp ~42k,
  buzz-db ~42k) plus a 278k-LOC desktop app, 62k mobile app, ~5.5k unit tests,
  143 Playwright specs, a TLA+ conformance checker, and 18 CI workflows.
  Fez core is ~5k LOC + ~4k of packages. Much of the delta is legitimate
  (fez delegates the LLM loop to third-party harnesses and the database to a
  dumb relay); this file tracks the parts that aren't.

**Grades** used throughout:
`AHEAD` fez is better · `PARITY` same decision, equivalent depth ·
`SHALLOW` fez has it but thinner (what's missing is noted) ·
`MISSING` no fez counterpart · `N/A` only makes sense with Buzz's
server-authority architecture; fez's dumb-relay/client-trust answer covers it
or replaces it.

---

## 1. Where fez is genuinely ahead

Credit where due — these are verified, not assumed:

- **Headless client brain** (`packages/fez-client`): messages, threads,
  reactions, unreads, presence, jobs, docs, DMs as one materialized view with
  a typed event surface. Buzz's SDK has nothing like it; the equivalent logic
  is smeared across their relay and desktop app.
- **NIP-17 DM crypto** (`src/dm.ts`): full gift-wrap implementation with
  self-copy, loop guards, fuzz-window handling. Buzz's SDK has no DM builder
  at all (DMs are relay commands there).
- **Depth-tag chain caps** on agent↔agent loops (channel *and* DM form).
  Buzz has no depth tags; a mention loop there is only stopped by turn budget.
- **Idle self-exit** (`idleExit:` persona key): agent finishes in-flight work,
  exits, gets re-summoned on mention. This is Buzz's VISION_REMOTE_AGENTS
  aspiration, shipped.
- **Capability honesty**: fez prompts disclose missing skills to the agent;
  Buzz agents silently have or lack tools.
- **Kind 20003 drafts** (streaming message preview) — genuinely novel, no
  Buzz equivalent.
- **Sliding-window rate limiting** in fez-relay policies — algorithmically
  nicer than Buzz's fixed window (their own comments call it an upgrade
  target).
- **Description-for-routing** in personas: measured finding (verb phrases
  route better on small models) feeding 47000 discovery; Buzz's description
  is display-only.
- **Loud in-channel failure notices**: a dead-lettered fez turn tells the
  channel; Buzz dead-letters to logs.
- **Engram (NIP-AE) implementation**: spec test vectors pass; arguably
  cleaner than Buzz's own.

---

## 2. Critical gaps (cross-cutting, ranked)

These surfaced independently in multiple audit slices and are the ones that
bite hardest.

### 2.1 `RelayConnection` never reconnects  — *most dangerous single gap*
One dropped WebSocket permanently deafens a standing agent. Defeats the
"works while your terminal is closed" pitch entirely; the sentinel and every
`fez agent` are one network blip from silence.
Buzz (`buzz-acp/src/relay.rs`): reconnect with `since` watermark (minus
skew), ping/pong liveness with pong deadline, backoff ladder 1s→30s with
stability reset. Fez `src/relay.ts`: none of it, and `publish` failures on
replies are swallowed (`.catch(() => {})`).

### 2.2 Relay ingest hygiene (fez-relay)
All small, all proven defaults, all currently absent (`packages/fez-relay`):
- **Event-id dedup at ingest** — replayed EVENTs double-store in memory +
  JSONL and REQ returns duplicates.
- **`created_at` drift fence (±900s)** — one `if`. Every client-side
  latest-wins derivation (membership, edits, read state) trusts `created_at`;
  a backdated event is fez's equivalent of a DB-integrity attack.
- **Size caps** (Buzz: 256KB content / 512KB frame) — one 100MB EVENT lands
  in memory and the store.
- **Per-connection limits** (Buzz: 1024 subs, 10 filters/REQ, limit clamp
  1000) + connection cap + backpressure — nothing bounds a client today.
- **Replaceable-event compaction (NIP-16/33)** — fez stores every revision of
  30078 read-state (debounced publish per channel view!) and 39005 summaries
  forever, then replays the whole store at boot. Highest value-to-effort in
  the storage slice.
- **REQ `limit` bug**: applied as `slice(-limit)` over insertion order, not
  `created_at DESC` per NIP-01.

### 2.3 The missing read-side seam (one seam, four gaps)
`RelayPolicy` is write-side only (`onEvent`). Four Buzz mechanisms all fail
to port for the same reason:
- **Private-channel read privacy** — a non-member can REQ or subscribe `#h`
  and receive full plaintext history/live events. Clients drop them on
  derivation, but content confidentiality is the one thing client-side trust
  cannot enforce for each other. Buzz's invariant: "a registered subscription
  is never sufficient for delivery."
- **Deletion masking** in REQ replies (see 2.4).
- **NIP-42 connection auth** (portable to a dumb relay — it's connection
  auth, not data authority).
- Pairing subscription-exclusivity (if pairing lands, §5).
Adding `onDeliver(event, subscriberCtx)` / a connection hook to
`policies.ts` unlocks all four.

### 2.4 Messages are undeletable
Kind 5 currently retracts only reactions/pins/bookmarks. A 47103 channel
message cannot be deleted by its author, a moderator, or anyone:
`handleDeletion` ignores it, the relay stores and re-serves it forever, and
no `/delete` command exists. Buzz soft-deletes with honest tombstones
("an honest tombstone instead of a silent hole" — VISION_MODERATION).
Smallest port with the largest user-facing trust payoff.

### 2.5 The trust boundary is untested
Fez moved Buzz's entire relay ACL layer into client-side trust rules
(`community-state.ts`, FezClient handlers) — and has **zero tests for
exactly that code**. Committed tests: 6 files, ~37 cases, all in fez-evals
(DM crypto and engrams are well covered; both are pinned to spec vectors).
Untested: FezClient (1,099 lines), community-state (the security boundary),
relay.ts (contains two comment-documented bug workarounds), fez-relay
policies, CLI, TUI. Buzz: ~5.5k unit tests + ~245 E2E + TLA+ conformance
with an independent replay checker. Infra already exists undriven:
`dev/local-relay.ts` is an ideal E2E substrate. No CI (`.github/` absent).

### 2.6 Kind registry drift
`src/kinds.ts` ("the full docs") and fez-client's `K` table have already
diverged: 7 kinds exist only in the K table (read state, edit, pin,
bookmark, scheduled, reminder, doc). Nothing checks agreement. Buzz has
`ALL_KINDS` + duplicate-detection test + compile-time range asserts.
Fold into one registry with an integrity test.

### 2.7 Agent-runtime hardening (vs buzz-acp/buzz-agent)
- **Turn timeouts mis-sized and hardcoded**: fez idle 30s / hard 5min
  (`DEFAULT_TIMEOUTS`, harness.ts). Buzz: idle **900s** (deliberately > the
  600s max shell-tool timeout) and hard **2h**, both tunable. A single 40s
  quiet tool call kills a fez turn today. Fix: adopt Buzz's numbers for
  session mode + per-persona override via `extra`.
- **No handoff across session recycle**: at `SESSION_TURN_CAP` (20) the
  replacement session is primed from scratch — turn 21 has amnesia beyond
  the 10-message window. Buzz prompts the dying context for a handoff
  summary (original task / done / decisions / next step) and folds it in.
- **No usage/cost tracking anywhere** (Buzz usage.rs: 3.5k LOC, ~90 tests;
  per-turn kind-44200 metrics with fail-closed `delta_reliable` semantics).
  Fez agents burn money with zero visibility; ACP adapters already surface
  usage for some engines and fez discards it. Observer stream is positioned
  to carry it.
- **Observer stream is one-way**: `/watch` can see a turn going wrong but
  can't cancel it or switch models. The abort plumbing (`turnController`)
  exists; it has no remote trigger. Buzz: freshness-windowed, owner-signed
  cancel/switch control events.
- **Retry depth**: fez gives one replay into a fresh session, then drops the
  event. Buzz retries 5s→300s backoff before dead-lettering — a 2-minute
  relay blip loses user requests fez-side.
- **Queueing**: one global `busy` flag for channel *and* DM paths,
  `pendingMentions` capped at 3, overflow silently dropped, no batching.
  Buzz: per-channel queues, FIFO fairness, drains up to 50 events into one
  coherent prompt.
- **Observer frame O(n²)**: each 150ms frame republishes the full
  accumulated text; Buzz coalesces chunks under a 4MB budget with 60KB caps.
- **No heartbeat turns**: fez agents are purely reactive; nothing wakes one
  to check for missed mentions/approvals (backfill runs only at startup).
- **No permission modes**: fez auto-approves everything (flagged in-code as
  "revisit before non-MVP"); Buzz has default/acceptEdits/bypass per agent.
- **No mid-session model switching**; static per-persona pin only.
- Rate limiting is per-pubkey only — key minting is free; Buzz layers
  per-IP admission + a connection semaphore.

---

## 3. Missing feature surfaces

Things Buzz users/agents have that fez simply doesn't. All fit the
extension-store model unless noted.

| Feature | Buzz | Fez shape when built |
|---|---|---|
| **Media / attachments** | buzz-media: Blossom (kind 24242 auth), magic-byte MIME validation, thumbnails + blurhash, streaming video | `fez-media` extension against any public Blossom server; pure client-side, zero relay changes. Biggest UX gap. |
| **Profiles (kind 0)** | Every surface; names/avatars/NIP-05 | Currently only agents have names (47000); a second human is a hex string. Also unlocks standard-nostr-client interop (kinds 0/1/3 are all absent). |
| **Search** | buzz-search: Postgres FTS, NIP-50; "index is the write" | SQLite FTS5 in fez-relay's SqliteEventStore + NIP-50, or client-side index. Key ported decision: hits are candidates, client trust rules re-filter — exactly fez's model. (#43) |
| **Moderation** | Reports (1984, kept private), bans/timeouts (9040-44), admin console, guard rails | Report intake NIP-44-encrypted to the creator (public relay makes plaintext 1984 impossible); creator-signed ban lists consumed by clients *and* a `moderationPolicy` sibling of `membershipPolicy` — enforcement port needs zero new seams. Roles (`admin`/`member`/`bot`) are parsed today and checked by nothing. (#42) |
| **Group DMs** | Up to 9 members | fez NIP-17 is strictly 1:1; "you + researcher + reviewer, privately" doesn't exist. |
| **Roster removal** | Member remove + NIP-43 lifecycle | The 47102 primitive supports it; no command/UI exposes it (invite adds only). Note: same-second 47102 tie-break is first-seen-wins (`<` in community-state) — Buzz explicitly bumps timestamps; fez's is undefined-by-luck. |
| **Device pairing** | NIP-AB kind 24134, QR, SAS + transcript-hash MITM detection, hardened sidecar relay | `fez-pairing` extension over the ordinary relay; the sidecar's validation tightenings become an ingest policy. Today the only second-device path is manual ncryptsec copy-paste. |
| **Agent activity feed** | VISION_ACTIVITY: 12 render classes, verb-object-outcome, never-go-dark, raw rail | The most fez-relevant product doc Buzz has (43k-LOC desktop feature); fez shows typing/progress but has no activity taxonomy. |
| **Encrypted reminders** | 30300 NIP-ER, author-only | fez 40007 reminders are **plaintext with a public `remind_at`** — private data on a public relay. |
| **User status** | 30315 ("away", "focusing") | We stop at presence dots. |
| **Forum** | 45001-3 posts/votes/comments | Long-form surface; extension-sized. |
| **Remote agent bodies** | buzz-backend-kubernetes: provider wire contract (one JSON in/out, converge-to-one-instance, fail-closed with key, per-attempt immutable Secrets) | *More* at home in fez than Buzz: identity/memory already live on the relay, and the sentinel already has the lifecycle philosophy (spawn on attention, self-reap, relay as only tether) for local bodies. A `fez-remote` provider (docker/fly/k8s) slots into the sentinel's spawn seam. |
| **Fez MCP server for harnesses** | buzz-dev-mcp gives agents tools + a git-identity shim (key never in env) | Nothing gives a harness agent first-class fez tools (send/read channel, mem, doc are CLI-side). Seam exists: `registerMcpServer()`. |
| **Workflow vocabulary** | 7 action types, step outputs, per-step timeouts, durable runs, `call_webhook` behind elevated-authority (SEC-006) | fez-workflows is at architectural parity (triggers/approval/traces — and the 47200 single-kind trace is a clean decentralization) but has ~2 of 7 actions and in-memory suspensions. Fill-in, not redesign. |
| **Persona packs** | plugin.json manifests, defaults+override merge, `pack validate`, size bounds, path-traversal guards | Extensions can't register personas; persona files are hand-placed, `extra` is unvalidated (a typo'd key silently no-ops). (#35; Buzz also publishes personas on-relay as 30175-178, `shared`-tag-gated.) |
| **Turn metrics** | kind 44200 durable encrypted per-turn cost | See §2.7. |
| **Audit trail** | buzz-audit: per-community SHA-256 hash chain, 11 action types | fez reserved 47020 and never implemented it. Fez's signed events already beat Buzz's keyless chain per-entry; what's missing is completeness (gap detection — a prev-hash chain proves nothing was dropped). Indexer-shaped. |
| **Scriptable CLI for automation** | buzz-cli: JSON stdout, typed exit codes, `--output compact` | fez CLI can't send/read a channel message from a script, has no JSON mode/stable exit codes (cron/CI glue). `mem` lacks `patch --base-hash` optimistic concurrency. |
| **Pre-authorized join codes** | HMAC invite tokens | Invite someone whose pubkey you don't know yet — no fez story. |
| **Mentions feed** | `event_mentions` table ("everything that #p's me") | Just an `#p` REQ + UI; fez-relay already supports the filter. Unbuilt UX. |
| **NIP-11 relay info doc** | Standard | Cheap; would advertise the operator's policy set. |
| **Custom emoji, home feed, pulse notes, long-form 30023, NIP-51 lists, NIP-65 relay lists** | Desktop/mobile | Absent; mostly extension-sized, NIP-65 matters if multi-relay ever lands. |

**Engineering maturity** (from Part B of the surfaces audit): no CI, no
CHANGELOG, no release process (every package at 0.1.0 — incoherent for an
app-store model), no TESTING.md, no supply-chain config, no deploy story
beyond the Supabase example. Buzz's `RELEASING.md` + self-tested release
scripts are the reference when the store model gets real.

---

## 4. Corrections to earlier assumptions

Findings that fix things previously believed in-project:

- **buzz-voice is not huddles** — it's local TTS (Kyutai Pocket, voice
  cloning) for the desktop app. Desktop-UX-only; nothing architectural.
  (Huddles/voice-rooms live in the desktop `huddle` feature.)
- **buzz-relay-mesh is not federation** — it's intra-deployment pod-to-pod
  QUIC for ONE relay identity. Buzz has no cross-operator peering to port.
  Fez's availability answer would be multi-relay in the client Wire, not a
  mesh.
- **buzz-pubsub is Redis**, not Postgres LISTEN/NOTIFY.
- **Buzz has no PoW** and **no server-side unread state** — their read state
  is client-signed encrypted 30078, exactly fez's design.
- **sprig** is a 53-line multicall binary: the whole agent runtime as one
  pinnable artifact. N/A for npm distribution; the *decision* (one pinned
  artifact per agent body) matters when remote bodies land.
- **push-gateway is APNs-only** (no FCM), App-Attest-gated, content-free
  ("reconnect now" — content flows over the relay socket). Inherently a
  centralized operator service; N/A until fez has a mobile surface, then
  copy the decisions (content-free wake, opaque grants, epoch fences),
  never the crate.

---

## 5. N/A by design (tracked so we stop re-asking)

Server-authority mechanisms fez's architecture answers differently, verified
covered: NIP-42/98 at the door (policies key on signed pubkeys instead —
though see §2.3 for the read side), NIP-43/29 relay-managed membership
(creator-signed 47102), relay-signed sidecars 40901/40902/39006/40099/44100-1
(client derivation + indexer pattern), DM command kinds 41001-12 (rejected in
`dm.ts` — though group DMs need a fez-native answer, §3), replica
read-routing/fence rings (single-node; the largest engineering investment fez
gets to skip), multi-tenancy fences (process-per-tenant), community deletion
pipeline (delete the store file; keep the "verifiable deletion" decision),
migration machinery (BYO storage), buzz-agent's LLM engine internals
(harness-owned: transport, agent loop, OAuth, hints/skills, reply guard),
buzz-dev-mcp's shell/file tools (harness-owned), scopes/API tokens (no HTTP
plane), OAuth scopes, sprig, per-kind envelope validators (clients validate
on read; costs garbage storage, not correctness).

---

## 6. Ranked roadmap

Consolidated from all six audits. Effort ≈ S (<1 day) / M (days) / L (week+).

| # | Gap | Effort | Why now |
|---|---|---|---|
| 1 | ✅ CLOSED `1878cb1` — Relay reconnect w/ `since` watermark + publish confirm (§2.1) | M | Every standing agent is one blip from permanent silence. |
| 2 | ✅ CLOSED `39a586a` — Ingest hygiene bundle: dedup, drift fence, size caps, sub limits, REQ-limit fix (§2.2) | S | ~40 lines total, proven defaults, closes real correctness bugs. |
| 3 | ✅ CLOSED `56558c9` — Turn-timeout sizing + per-persona override (§2.7) | S | 30s idle kills legitimate work today. |
| 4 | ✅ CLOSED `a7c7e82` — Message deletion + tombstones + `/delete` (§2.4) | M | Smallest port, largest trust payoff; needs client + store masking. |
| 5 | ✅ CLOSED `575faf4` — Trust-boundary tests over `dev/local-relay.ts` + CI + registry integrity test (§2.5, §2.6) | M | The security boundary is unexercised; infra already exists. |
| 6 | ✅ CLOSED `575faf4` — Replaceable-event compaction in fez-relay (§2.2) | M | Unbounded growth from our own chattiest kinds. |
| 7 | ✅ CLOSED `f72ef07` — Read-side policy seam (`onDeliver`/connection hook) → read privacy, deletion masking, NIP-42 (§2.3) | M | One seam, four gaps; the only enforcement clients can't do for each other. |
| 8 | ✅ CLOSED `56558c9` — Session handoff summary on recycle (§2.7) | S | Turn 21 amnesia; prompt the dying session, fold into prime. |
| 9 | ✅ CLOSED `3996a8f`+`f993d65` (profiles, /status, /kick, group DMs) — Profiles (kind 0) + group DMs + roster removal + `/status` (§3) | M | Rounds out the chat core for the second human. |
| 10 | ✅ CLOSED `701e642` — fez-media (Blossom) extension (§3) | M | Biggest UX gap; zero relay changes. |
| 11 | Usage metrics (per-turn encrypted frames, fail-closed deltas) + observer control channel (§2.7) | M | Cost visibility + the ability to stop a bad turn. |
| 12 | fez-search (FTS5 + NIP-50) (§3, #43) | M | Candidates-not-authority model matches fez trust exactly. |
| 13 | fez-moderation: encrypted reports + signed ban lists + relay policy (§3, #42) | M | Enforcement half needs zero new seams. |
| 14 | Workflow vocabulary fill-in + durable runs (§3) | M | Skeleton at parity; fill proven vocabulary. |
| 15 | Fez MCP server for harness agents (§3) | M | Agents currently can't act on fez itself mid-turn. |
| 16 | ✅ CLOSED `2524a65` — Encrypted reminders (privacy fix) (§3) | S | Private data currently plaintext on the relay. |
| 17 | Remote agent bodies: provider wire contract + `fez-remote` (§3) | L | The most vision-aligned L; sentinel seam is ready. |
| 18 | Persona packs + `persona validate` (§3, #35) | M | Store-model coherence. |
| 19 | Device pairing (NIP-AB) (§3) | M | Second-device onboarding for keychain-held roots. |
| 20 | Activity feed taxonomy in the TUI (§3) | L | Buzz's best product thinking applied to fez's core thesis. |

Deliberately unranked until their preconditions exist: forum, pulse, custom
emoji, phone push (needs mobile), voice/TTS, git forge + signing (needs a
repo story), relay mesh (needs a scale problem).
