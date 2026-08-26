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

## 0. Diagnosis workstream (gates everything)

Before UI work, run systematic-debugging on the two failures, witnessed by
`e2e-cold-start.sh` on the mini (the E2E-before-ship rule applies to this
whole spec). Suspects to confirm or eliminate:

- **pi authed-gate:** `readiness()` in `welcome.ts` — `authed:
  claudeReady || (!!harnesses["pi"] && chutes)`. Must become "pi + any
  configured provider credential", not Chutes specifically.
- **Runner chain:** does the bundled sentinel actually start on a fresh
  machine (pidfile via `runner_status`), and does it wake personas by
  mention? The six-binary bundle exists; verify the spawn path end to end.
- **Teammate rostering:** @fez gets `client.invite(agentPk, "bot")` +
  `attestAgent`; the teammates get neither. Confirm whether the sentinel
  gives woken personas their own keys and whether those keys are rostered —
  an unrostered teammate's intro would be invisible (the exact bug the
  roster fix caught for @fez).
- **pi turn completion:** with a valid provider key, does a pi-acp turn
  actually complete from the app? (invoke\<T\> is a cast, not a check —
  verify the real payloads.)

Findings feed the implementation plan; anything structural discovered here
upgrades this spec.

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

- **Bootstrap creates `#welcome`** (private — roster: owner + the three
  agent keys) alongside general. `ensureWelcome` targets it instead of
  `bootstrap-general`; App.tsx opens `#welcome` on first post-onboarding
  boot.
- **Migration/idempotency:** existing installs whose opener markers live in
  general are left alone (markers are relay-side; a new #welcome on an old
  workspace would re-greet — so `ensureWelcome` checks BOTH channels for
  markers before posting, and only ever posts into #welcome).
- **Rename starter ids:** `STARTER_TEAM` → `drift` (researcher
  description/prompt) and `quill` (scribe description/prompt). Persona
  files `drift.md`, `quill.md`.
- **Roster + attest teammates:** `ensureStarterTeam` gains the same
  invite/attest treatment @fez gets — each teammate's agent key (however
  the sentinel derives it — per diagnosis) is made a member of #welcome
  before the summons posts.
- **Readiness gate widened:** `authed` = claudeReady OR (pi bundled AND any
  provider credential configured). Effort/provider/model come from
  `fez.md`.
- Choreography itself is already written and stays: hello → opener →
  summons (real turns — teammates' models answer as themselves, in a
  thread per Buzz) → intros counted → kickoff question, all
  relay-marker-idempotent.
- **Thread shape:** Buzz's intros land as thread replies to the summons.
  fez's teammates reply wherever the sentinel puts them today; if that's
  in-channel rather than threaded, keep it — thread mechanics are not
  worth blocking on. The kickoff waits on intros either way.

## Testing

- Unit: welcome-core changes (persona effort field, marker checks across
  two channels, team rename) — the existing fez-evals surface.
- The addressing eval that pins `teamOpenerText` against the real parser
  must pass with the new names (@drift, @quill).
- E2E: extend `e2e-cold-start.sh` to assert (a) #welcome exists and is the
  opened channel, (b) opener + summons + two intros + kickoff appear, (c)
  a pi turn completes with a configured provider. Ship gate: passes on the
  mini.
- Manual: the four provider verify paths (one real key each where
  available; error path for a garbage key).

## Out of scope

- Buzz's full-page wizard chrome, sign-in/email auth, claimed
  `*.communities` addresses (fez's create-door claims a local workspace
  instead).
- Codex/Goose/other harness cards (the PROVIDERS/harness tables are the
  seam; cards come when the harnesses do).
- Blossom-backed avatar upload; media settings.
- Funded free-tier brain (the readiness probe remains the seam).
