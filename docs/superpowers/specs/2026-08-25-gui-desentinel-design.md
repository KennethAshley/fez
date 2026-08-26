# De-sentineling the GUI — desktop-owned summons, relay-fired schedules

**Date:** 2026-08-25 · **Status:** draft for review · **Reference:** Buzz (`/Users/ken/Projects/buzz`)

## Motivation

fez was built TUI-first, so the always-on sentinel became the home for
everything agent-shaped: mention/DM summons, scheduled sends, reminders,
OS notifications, extension background tasks. The desktop app then
inherited that dependency wholesale — it can't spawn an agent itself, so
it auto-starts a sentinel every boot and gates its welcome flow on the
sentinel's pidfile.

Buzz — the reference implementation — draws the lines differently, and
better, for a GUI:

- **The GUI process owns the agent lifecycle.** Buzz's Tauri app spawns
  `buzz-acp` directly (`managed_agents/runtime.rs:406`), restores agents
  on launch, and tears down the whole process tree on window close.
  There is no local daemon at all.
- **Anything time-based lives with the relay, not on a client machine.**
  Workflow cron, reminders, presence — all `tokio::spawn` loops inside
  `buzz-relay` (`crates/buzz-relay/src/main.rs:645,741`). Closing the
  desktop app affects none of it. Buzz's axiom: *the GUI is not a
  scheduler, and neither is the user's laptop.*

What our desktop pays for the inherited model, today:

- `ensure_agent_runner` auto-spawn on every boot (`fez-desktop/src-tauri/src/lib.rs:1699-1751`)
  — a plain detached child, no launchd, no KeepAlive. It dies at logout,
  so the GUI pays the daemon tax without getting daemon durability.
- `readiness()` polling `runner_status` 12×500ms at boot
  (`fez-desktop/src/welcome.ts:85-94`) before `@fez` may say hello.
- "run `fez sentinel` in a terminal" copy inside the welcome flow
  (`welcome-core.ts:61-63`) and a 60s toast asking "is the watcher
  running?" (`App.tsx:1694`) — in a GUI whose AgentsPane promises "no
  daemon to configure" (`AgentsPane.tsx:668-673`).
- A bundled `fez-sentinel` binary (`prepare-pi-agent.mjs:145-153`) whose
  only GUI-relevant duties the GUI could do itself while it's open.

## Design overview

Four workstreams, in landing order:

1. **Desktop-owned summoner** — the GUI summons agents from its own live
   subscription while it is open.
2. **Native notifications** — the GUI toasts from its own subscription;
   no sentinel in the path while the app is open.
3. **Relay-fired schedules** — scheduled sends become pre-signed sealed
   intents released by a relay-side executor; reminders stay
   client-fired.
4. **Sentinel demotion** — the sentinel returns to what it is for the
   TUI: opt-in fleet infrastructure. The desktop stops auto-starting,
   bundling, and gating on it.

An appendix lists unrelated drift found during the cross-reference.

---

## 1. Desktop-owned summoner

**Current.** Only the sentinel can turn an `@mention`/DM into a running
agent process (`fez-sentinel/src/index.ts:252-287,402-422`). The desktop
watches the same events live but only renders them.

**Target.** While the desktop is open it performs summons itself:

- **Policy extraction.** The summon policy — mention parsing, owner/
  attested-sibling authority (47006 gate), flood/cooldown guards,
  self-summon guard, work-context resolution from `⑂` markers — moves
  out of `fez-sentinel/src/index.ts` into a shared module (new
  `src/agent/summon.ts` in `@fezchat/protocol`, or a `fez-client`
  module: whichever the implementer finds keeps the sentinel's imports
  clean). The sentinel imports it back; behavior there is unchanged.
  One policy, two hosts — no drift.
- **Desktop wiring.** The webview already receives every channel
  message/DM on its live wire. It runs the shared policy against each
  event and, on a summon verdict, calls a new Tauri command
  `spawn_agent(persona, channels, workspaceEnv)` — Rust `Command::new`
  on the already-bundled `~/.fez/bin/fez-agent`, detached, same env
  contract the sentinel uses (`FEZ_AGENT_PERSONA`, `FEZ_AGENT_CHANNELS`,
  `FEZ_AGENT_OWNER`, `FEZ_RELAY`), logs to `~/.fez/logs/`. The spawn
  mechanics mirror `ensure_local_relay`'s existing spawn code.
- **Roster + attestation.** Pre-invite (KIND_MEMBERSHIP update) and
  sibling attestation (47006) are plain owner-signed publishes — the
  desktop runs as the owner and already signs via the Rust signer. Both
  move into the shared policy module's "on summon" sequence so desktop
  and sentinel do them identically.
- **Detached, not window-children.** Buzz kills agents with the window;
  we deliberately keep detached spawns. Agents surviving the app is
  on-thesis for a fleet — closing the window should not kill an agent
  mid-task. (This is the one place we diverge from Buzz knowingly.)
- **Double-spawn guard.** If a sentinel is alive (pidfile), the desktop
  defers summoning entirely — one summoner per machine, sentinel wins.
  Both hosts already share the `agentProcessAlive` process-check; the
  pidfile check is one read at event time (cheap, no polling loop).
- **Spawn failure.** The sentinel's 90s channel-message watchdog is
  replaced, in the desktop path, by inline UI: a toast/thread notice if
  the summoned persona hasn't announced in 90s. Same timeout, better
  surface.

**Deleted from the GUI:** the boot-time dependency. Mentions work the
moment the app opens, with no external process.

## 2. Native notifications

**Current.** Owner-DM/mention/failed-turn toasts route
sentinel → herdr `notification.show` → `osascript` fallback
(`fez-sentinel/src/index.ts:120-135,656-663`) — even while the desktop
app is open and rendering the same events.

**Target.** The desktop shows OS notifications itself from its live
subscription (Tauri notification API), for: DMs to the owner, mentions
of the owner, failed agent turns (observer frames it already receives).
Rules: suppress when the relevant channel is focused; nothing fires for
events the webview never saw (that's the sentinel's job, app-closed,
opt-in). The sentinel's notification path is untouched for TUI/headless
users — but when the desktop is open and a sentinel is also running,
the sentinel already owns summons (workstream 1's guard); to avoid
double toasts the desktop suppresses its own notifications whenever the
sentinel pidfile is alive. One notifier per machine, same rule as
summons.

## 3. Relay-fired schedules (and honest reminders)

**Current.** `/schedule` publishes kind 40006 (content = plaintext
message, `send_at` tag); `/remind` publishes kind 40007 (NIP-44
self-encrypted). The sentinel arms timers and fires both
(`fez-sentinel/src/index.ts:667-724`). If no sentinel runs, intents
queue forever. The desktop ships the composer commands and a
RemindersPane that is explicitly "the ledger; the sentinel is the
executor."

**Why we can't copy Buzz directly.** Buzz's relay is a trusted server:
it holds authority and can materialize a scheduled message itself. fez's
relay is deliberately dumb — it holds no user keys and must never sign
as a user. A naive relay-side scheduler would break the no-server-
authority thesis.

**Target — pre-signed sealed intents.** The signature moves to schedule
time, so the executor needs no keys:

- At `/schedule`, the client builds and signs the **final 47103** with
  `created_at = send_at`, then embeds it (JSON, optionally NIP-44'd to
  the author for privacy-in-queue) inside the 40006 intent's content.
- A relay-side **executor** — shipped as a relay extension via the
  existing `relay` part seam (`~/.fez/relay-extensions`), bundled
  default-on for the desktop's local relay and installable on
  relay.fez.chat — watches stored 40006s, and at `send_at` simply
  **releases** the embedded, already-signed event into the relay's
  store/broadcast. It authors nothing.
- **Cancellation:** author tombstones the 40006 (kind 5) before
  `send_at`; the executor checks tombstones at fire time. After release
  the executor publishes its own consumption marker (or the relay drops
  the intent) so restarts never re-fire — the executor may sign *its
  own* bookkeeping, never user content.
- **Trust:** clients apply the normal membership rule to the released
  47103 (author must be on the roster) — nothing new to trust; the
  executor is a timestamp escrow, not an author.
- **Compat:** the sentinel learns the sealed format too (release the
  embedded event instead of authoring a fresh one) and keeps firing
  legacy plaintext 40006s during a deprecation window. Desktop composer
  switches to sealed-only.

**Reminders stay client-fired.** Firing a reminder = notifying a human;
a relay can't toast a closed app and we have no push infrastructure
(Buzz uses a push gateway). So: the **desktop fires reminders itself**
while open (it can decrypt its own 40007s and schedule an in-process
timer + native notification); the **sentinel remains the app-closed
executor** for people who opt in. RemindersPane copy changes from "the
sentinel delivers them" to "delivered while fez is open — install the
sentinel for delivery when it isn't."

## 4. Sentinel demotion (desktop side)

With 1–3 landed, the desktop needs the sentinel for exactly nothing
while it is open. Changes:

- Remove `ensure_agent_runner` and its `App.tsx:192` call. Keep
  `runner_status` (one cheap pidfile read) only as the shared
  "sentinel alive?" guard for workstreams 1–2 and as an informational
  badge in settings ("fleet watcher: running / not installed —
  `fez sentinel-install`").
- Remove sentinel gating from `readiness()`/welcome: `@fez`'s opener no
  longer needs a runner check; the "nothing's listening for mentions"
  branch and the 60s watcher toast are deleted.
- Stop bundling `fez-sentinel` in `prepare-pi-agent.mjs` and remove it
  from `copy_agent_files`. (People who want it get it with the CLI —
  it was never the desktop's to ship.)
- `backgroundExtensions` (`fez.parts.background` — bench, git, github,
  live-blocks) remain sentinel-only by design: the sentinel stays "the
  only always-on key-holding host" for scheduled extension tasks. The
  desktop's `install_package` keeps recording the settings entry so an
  opt-in sentinel picks them up; the extension install dialog gains one
  honest line: "background tasks run when the fleet watcher is
  installed."
- TUI and CLI paths (`fez sentinel`, `sentinel-install`, doctor warn)
  are untouched.

**Net desktop deletions:** auto-spawn + boot polling + welcome gating +
watcher error copy + one bundled binary + one failure mode from
cold-start (directly simplifies the onboarding readiness work).

## Landing order & risk

1. **Summoner** (biggest UX win; removes the boot gate). Risk: policy
   extraction must not change sentinel behavior — extract-and-reimport
   with the sentinel's existing behavior as the test oracle.
2. **Notifications** (small, independent).
3. **Scheduler extension** (protocol change: sealed 40006 format —
   document in `kinds.ts`, dual-format sentinel during transition).
4. **Demotion** (only after 1–3 are verified in the app).

Each lands separately; nothing here blocks on the others except 4.

## Out of scope

Killing the sentinel for TUI users (it stays, unchanged); push
notifications; herdr integration changes; moving `background`
extension tasks relay-side (revisit per-extension later); Windows/Linux.

---

## Appendix: drift found during the cross-reference (separate pass)

- `fez-desktop/src/wire.ts` re-implements `src/protocol/relay.ts`'s
  reconnect/dedup/fan-out by hand and imports `nip11.ts` via a raw
  `../../../src/` relative path — packaging smell, drift risk.
- Kind constants re-declared in `packages/fez-client` (`K.SCHEDULED`
  etc.) instead of imported from `src/protocol/kinds.ts`.
- `@fez` starter-persona text duplicated in `fez-desktop/src/welcome.ts`
  (documented, but workstream 4 touches that file — good moment to
  fold).
- Two independent pidfile readers (Rust `pid_alive` vs node
  `process.kill(pid,0)`) for `~/.fez/sentinel.pid` — fine, but the
  "sentinel alive?" guard added in workstreams 1–2 should reuse the
  Rust one, not add a third.
