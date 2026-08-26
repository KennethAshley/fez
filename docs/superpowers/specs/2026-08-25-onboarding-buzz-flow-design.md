# Onboarding, Buzz-shaped: harness page, community doors, starter team, #welcome

*2026-08-25 · fez-desktop · supersedes decision 3 ("no starter trio") of
2026-08-24-cold-start-onboarding-design.md; builds on everything else in it*

## Problem

The cold-start work landed the machinery — scripted opener, starter-team
choreography in `welcome-core.ts`, brain step, local workspace — but the
experience Ken sees on real hardware is broken in two ways and incomplete in
several more:

1. **The bundled harness doesn't work.** `readiness()` counts pi as authed
   only when a Chutes key exists, and the runner probe depends on the sentinel
   chain actually spawning from the bundle. On a fresh machine the guide says
   "I need a brain" and stops.
2. **The starter team never spawns.** `ensureStarterTeam` writes persona
   files and posts the summons, but the teammates are never rostered/attested
   the way @fez is in `ensureWelcome` — and the whole branch is gated behind
   the readiness that (1) breaks. Nobody has ever seen @researcher or @scribe
   speak.
3. The onboarding flow is missing Buzz's shape: no harness-selection page
   with live detection, no defaults page, no explicit community doors, no
   profile page, no meet-your-team moment, and the welcome lands in
   general instead of a dedicated channel.

Reference implementation: `/Users/ken/Projects/buzz/desktop/src/features/onboarding/`
(machineOnboarding, communityOnboarding, welcomeKickoff) and the 14
screenshots from Ken's Buzz walkthrough (2026-08-25).

## Decisions (locked with Ken, 2026-08-25)

1. **Keep the ob-card shell.** Extend the existing step flow in place; no
   port of Buzz's full-page wizard chrome (progress dots, gradient pages).
2. **Two harnesses on the harness page:** Claude Code (detected, Buzz-style
   states) and **Fez** — the bundled pi/pi-acp agent, presented as fez's own,
   always READY because it ships with the app.
3. **Fez-harness providers, v1:** Chutes, Anthropic, OpenAI, OpenRouter — as
   a data-driven list (one entry to add a provider later).
4. **Fez-harness config = provider + model + effort.** Claude-harness
   config = model only (its auth is the CLI login).
5. **Starter team = @drift (researcher) + @quill (scribe).** Qud cast names;
   both already have hand-drawn sprites and quips. @fez remains the guide.
6. **Welcome lands in a dedicated private `#welcome` channel**, not
   general. Created at workspace bootstrap.
7. **Step order:** welcome → harness → defaults → community → profile →
   meet your team → done → land in #welcome. Pairing/restore stay as side
   doors off the welcome card.
8. **Skip never soft-locks** (Buzz's rule, already ours): every step has a
   skip/later path, and the in-app fallbacks stay honest about gaps.
9. **The GUI does not use the sentinel** (locked with Ken, 2026-08-25).
   The sentinel was extracted from the TUI so the fleet works with no
   window open — that premise doesn't hold for the desktop, which is
   itself a long-lived process. The desktop supervises its agents
   directly (Buzz's `managed_agents` shape): it spawns the starter
   agents as managed children after bootstrap, reconciles them while the
   app runs, and stops them on quit. The sentinel remains the TUI /
   headless runner only. Guard rail: the desktop defers to a live
   sentinel pidfile (and vice versa via fez-acp's existing duplicate
   guard) so running TUI + GUI together never double-spawns a persona.

## 0. Architecture: desktop-managed agents (replaces sentinel-in-GUI)

Decision 9 dissolves the old "runner chain" diagnosis: instead of making
`ensure_agent_runner` → sentinel → summon → spawn reliable, the GUI owns
the lifecycle. What the desktop takes over from the sentinel (all
mechanisms it already half-has):

- **Keys:** per-persona keychain identity, service `fez-keys`, account
  `agent:<name>` — the same accounts the sentinel/CLI use
  (`loadOrCreateKey`), so an agent has one identity no matter who spawns
  it. The desktop already does exactly this for @fez (`AGENT_ACCOUNT =
  "agent:fez"` in welcome.ts).
- **Roster + attest:** the desktop client rosters and attests each
  managed agent's pubkey before it speaks (`client.invite(pk, "bot")` +
  `client.attestAgent(pk)`) — @fez already gets this; the teammates now
  do too. Attestation still matters for the TUI/sentinel world and for
  fez-acp's sibling gating.
- **Spawn:** the Tauri backend spawns `~/.fez/bin/fez-agent` per persona
  with the same env the sentinel's `agentEnvCmd` builds
  (`FEZ_AGENT_OWNER`, `FEZ_RELAY`, `FEZ_AGENT_PERSONA`,
  `FEZ_AGENT_CHANNELS`), logs to `~/.fez/logs/`, restarts on crash with
  bounded backoff, kills children on app exit.
- **Mention handling needs no watcher:** a running fez-acp agent has its
  own relay subscription and `respondTo` gating — agents that are alive
  answer their own mentions. The GUI keeps the trio alive; there is no
  wake-on-mention step to break.
- **Readiness:** `runner: true` when the managed trio is running
  (backend status query), replacing the sentinel pidfile poll. The
  `authed` half becomes "claude ready OR pi + any configured provider
  credential" (not Chutes specifically).

Remaining diagnosis (small, still first): with a valid provider key,
verify a pi-acp turn completes end to end from a desktop-spawned
`fez-agent` (invoke\<T\> is a cast, not a check — verify real payloads),
witnessed by `e2e-cold-start.sh` on the mini.

## 1. Step flow (Onboarding.tsx)

`Step` becomes: `welcome | invite | pairing | restore | reconnect | harness |
defaults | community | profile | team | done`.

- **welcome:** wordmark + lede, "get started" primary. The name input moves
  to the profile step. Side doors unchanged: invite, pairing, restore.
- Identity creation stays where it is (on leaving welcome), so every later
  step can sign and publish.
- Pairing/restore continue to reconnect → then join the main flow at
  **harness** (a second device still needs a local brain).

## 2. Harness page (replaces BrainStep's layout, keeps its probes)

Two cards, Buzz's detection grid:

- **Claude Code** — existing `claude_brain_status` drives the pill:
  READY / SIGN IN (run `claude /login`, "check again" link) / SET UP
  (one-time `ensure_claude_adapter` bridge) / INSTALL (opens
  claude.com/claude-code). Unchanged logic, new layout.
- **Fez** — bundled pi/pi-acp. Pill: READY always (presence is what it
  claims; the brain is configured next page). Hint copy: "ships with fez".

Continue requires nothing — this page is informational + detection; the
choice happens on defaults. (Buzz splits these pages the same way.)

## 3. Defaults page ("Configure your defaults")

- **Default harness** dropdown: Claude Code, Fez. Claude Code is offered
  only when its card reached READY; Fez is always offered.
- **Claude Code selected:** model dropdown — default / opus / sonnet /
  haiku, sourced from the same list ModelPicker uses (one source of truth).
- **Fez selected:** provider dropdown (Chutes, Anthropic, OpenAI,
  OpenRouter — from a `PROVIDERS` table: id, label, key-field hint, verify
  fn), API-key field, **verify** button that proves the key by listing
  models live (the existing `wire_chutes_pi` pattern, generalized per
  provider), then model dropdown + **effort** dropdown (low / medium /
  high).
- **Persona write:** `buildFezPersonaMd` gains an optional `effort` line in
  the frontmatter alongside provider/model. `parsePersonaBrain` reads it
  back; starter personas inherit it (existing mechanism, one new field).
- **Skip for now:** allowed; the in-app opener's honest "I need a brain"
  fallback covers it.

Provider verification failures render inline (Buzz page-4 behavior, already
ours for Chutes). Keys go through `set_skill_secret` per provider — never
localStorage.

## 4. Community page (three explicit doors)

Buzz's "Join or create a community", fez-shaped:

- **Join a community** → existing invite step (fez-join code or wss:// URL).
- **Create a community** → the current implicit default made explicit:
  names the local workspace, `ensure_local_relay` claims it. Input =
  workspace name, prefilled "your workspace" (community precedes profile in
  the locked order, so no user name exists yet; the workspace is renamable
  in settings).
- **I already have a community** → existing reconnect step (relay URLs;
  your key is your membership).

## 5. Profile page

- Username (required to continue past it, but the page itself is skippable
  — skip = no kind 0, fixable in settings).
- Avatar: optional. Skip = your generative pk sprite (that IS the fez
  identity story, so the empty state is already good). Upload publishes
  into kind 0 `picture` — small images inline as data URLs; anything
  fancier is out of scope for v1.
- Publishes kind 0 best-effort exactly as today (never blocks the door).

## 6. Meet your team page

Full card: the three sprites (fez, drift, quill) rendered by the existing
pixel-sprite machinery, names beneath in the sprite grammar (chosen-one
lighting), one line of copy — "fez brings agents into the same room; these
three will help you get started." Primary: **"take me to fez"** →
`onComplete`. The `done` backup-key card content merges into this page
(reveal-backup stays available here or moves to settings; either way the
key custody note survives somewhere on the exit path).

## 7. #welcome channel + kickoff choreography

- **Bootstrap creates `#welcome`** alongside general, via
  `client.ensureChannel({ name: "welcome", id: "bootstrap-welcome",
  visibility: "closed" })` — the same fixed-id converging-race shape as
  bootstrap-general. `ensureWelcome` targets it instead of
  `bootstrap-general`; App.tsx opens `#welcome` on first post-onboarding
  boot. Honesty note: fez has no per-channel membership enforcement —
  the relay's membership policy gates on the single workspace-wide
  roster, and `visibility: "closed"` is serialized but unenforced. In a
  fresh solo workspace the members are the owner + the trio anyway, so
  "private" is truthful in effect; real per-channel privacy is a relay
  policy for another spec.
- **Migration/idempotency:** existing installs whose opener markers live in
  general are left alone (markers are relay-side; a new #welcome on an old
  workspace would re-greet — so `ensureWelcome` checks BOTH channels for
  markers before posting, and only ever posts into #welcome).
- **Rename starter ids:** `STARTER_TEAM` → `drift` (researcher
  description/prompt) and `quill` (scribe description/prompt). Persona
  files `drift.md`, `quill.md`.
- **Roster + attest teammates:** `ensureStarterTeam` gains the same
  invite/attest treatment @fez gets — each teammate's key is the
  keychain identity `fez-keys` / `agent:<name>` (the account convention
  the whole stack shares), rostered + attested before the summons posts.
- **Spawn:** after rostering, the desktop starts @drift and @quill (and
  @fez) as managed children per section 0 — no sentinel involved. Their
  running fez-acp processes see the summons themselves and answer.
- **Readiness gate widened:** `authed` = claudeReady OR (pi bundled AND any
  provider credential configured). Effort/provider/model come from
  `fez.md`.
- Choreography itself is already written and stays: hello → opener →
  summons (real turns — teammates' models answer as themselves, in a
  thread per Buzz) → intros counted → kickoff question, all
  relay-marker-idempotent.
- **Thread shape:** Buzz's intros land as thread replies to the summons.
  fez's teammates reply wherever fez-acp puts them today; if that's
  in-channel rather than threaded, keep it — thread mechanics are not
  worth blocking on. The kickoff waits on intros either way.

## Testing

This work is centered on the GUI; the GUI is what must demonstrably work.
Three layers, all required before ship:

**1. Playwright GUI suite (new — the centerpiece).** fez-desktop currently
has no GUI tests; `e2e-cold-start.sh` seeds *around* onboarding, so the
wizard has zero automated coverage today. Adopt Buzz's proven pattern
(`buzz/desktop/tests/e2e/onboarding.spec.ts` + `helpers/bridge.ts`):
Playwright against the built vite bundle served over plain http (no Tauri —
tauri-driver has no macOS support), with an injected **mock native bridge**
that fakes the `invoke` layer deterministically (`detect_harnesses`,
`claude_brain_status`, `set_identity`, `ensure_local_relay`,
`set_skill_secret`, provider verify/model-list calls, `runner_status`) and
a mock relay for wire traffic. Specs to write:

- Full wizard walk: every step in the locked order, Back from every step,
  Skip from every skippable step — asserting skip never soft-locks.
- Harness page: all four Claude states (READY / SIGN IN / SET UP /
  INSTALL) via bridge fixtures; Fez card always READY.
- Defaults page: Claude → model list renders; Fez → each of the four
  providers verifies (mock success → models + effort appear) and fails
  honestly (garbage key → inline error, no advance); persona frontmatter
  written with provider/model/effort asserted through the bridge.
- Community page: all three doors reach their step and return.
- Profile: name publish, avatar skip = sprite fallback.
- Welcome kickoff rendering: with a seeded mock relay, #welcome is the
  opened channel and shows opener → summons → intros → kickoff; the
  general channel shows none of them.

Wired as `npm test:e2e` in fez-desktop + a playwright.config.ts; runs
headless locally and in CI.

**2. Real-hardware composition test.** Extend `e2e-cold-start.sh` to
assert (a) #welcome exists and is the channel the app opens, (b) opener +
summons + two real intros + kickoff appear in the relay store, (c) a pi
turn completes with a configured provider. Ship gate: passes on the mini
(the E2E-before-ship rule). The GUI wizard itself can't be automated on
macOS hardware — that's what layer 1 covers; the mini run proves the
native half the mocks stand in for.

**3. Unit + evals.** welcome-core changes (effort field, two-channel
marker checks, team rename); the addressing eval pinning `teamOpenerText`
against the real parser must pass with @drift/@quill.

**Manual before ship:** one human pass through the real wizard on the mini
(fresh account), including one real provider key verify (Chutes at
minimum) and the Claude Code READY path.

## Out of scope

- Buzz's full-page wizard chrome, sign-in/email auth, claimed
  `*.communities` addresses (fez's create-door claims a local workspace
  instead).
- Codex/Goose/other harness cards (the PROVIDERS/harness tables are the
  seam; cards come when the harnesses do).
- Blossom-backed avatar upload; media settings.
- Funded free-tier brain (the readiness probe remains the seam).
