# Cold-start onboarding: local workspace + guaranteed first message

*2026-08-24 · fez-desktop · follows the onboarding-tier1 audit (ONBOARDING.md)*

## Problem

A cold downloader (no invite) currently lands on the hosted relay — someone
else's claimed workspace. They aren't on its roster, can't open channels, and
the @fez that FirstRun tells them to mention runs on the owner's machine with
an owner-scoped respond policy, so their first message silently gets no
answer. Every concept fez needs them to learn (key ≠ account, relay =
workspace, agents are real processes) is only ever demonstrated by that first
answered mention — which is the step most likely to fail.

Reference: Buzz solves this with (a) no shared default relay, (b) a scripted,
client-signed opener so the room is never empty, and (c) real LLM replies only
where auth exists, with honest fallback copy where it doesn't.

## Decisions (locked with Ken, 2026-08-24)

1. **Default home = local workspace.** The app spawns a local `fez-relay`
   owned by the new user. No hosted default for cold users.
2. **No-key path = honest fallback card.** No funded free tier now; the
   readiness probe is the seam to add one later.
3. **Greeter = @fez alone.** One scripted opener, one real reply. No starter
   trio.

## 1. Local workspace bootstrap

**Ship the relay like we ship pi.** `packages/fez-relay` (ws + nostr-tools,
JSONL store) is bun-compiled by the `prepare-pi-agent`-style pipeline into
Tauri resources and copied to `~/.fez/bin/fez-relay` by the existing
`copy_agent_files` machinery (which already stages, strips quarantine, and
atomically renames). The release-CI `REQUIRE_PI_AGENT=1` gate covers it the
same way.

**Spawn + claim.** At onboarding completion with no invite and no pairing
(the plain "get started" path), the Tauri backend:

- writes the relay store dir `~/.fez/relay/`
- spawns `fez-relay --port 7777 --store ~/.fez/relay/events.jsonl
  --owner <user pk> --name "<name>'s workspace"` (name falls back to
  "your workspace" when the name field was left empty)
- writes a pidfile; the sentinel (once installed) and the app each ensure
  it is running on launch — same one-owner pidfile convention the sentinel
  uses. Loopback only; no listening on external interfaces.

`src/relay.ts` stays the single home of the default (the tier-1
consolidation is kept); its *value* changes from the hosted relay to
`ws://127.0.0.1:7777`. This is safe for existing users because everyone who
completed onboarding has a stored relay set (`localStorage["fez-relay"]`,
written at completion) that wins over the default — nothing migrates. The invite path is unchanged:
accepting an invite *widens* the relay set, so joining a real community later
requires no reconfiguration. The hosted relay remains reachable by invite,
never by default.

Because the local relay is claimed by the user at birth, the communities
extension's Home bootstrap — which is owner-gated and therefore never ran for
cold users on the hosted relay — now actually runs: the user gets a Home
community and a first channel they own.

## 2. Seeded Welcome + scripted opener

**@fez exists locally.** Onboarding ensures `~/.fez/personas/fez.md` (the
starter persona the CLI wizard already writes) and a local agent key
(`agent:fez` in keychain custody, created the same way fez-acp creates one on
first spawn).

**The opener is scripted and client-signed — never LLM output.** After the
Home channel exists, the app publishes one welcome message *signed by the
@fez agent key*, in fez's actual voice, saying only true things: this is your
workspace, on your machine; here's what @fez is; here's what to try. The
room is never empty regardless of harness/auth state.

**Idempotency by event marker.** The opener carries a
`["client", "fez-welcome.opener.v1"]` tag; before posting, the app queries
the channel for that marker and skips if present. Re-entry from a paired
second device, a reinstall, or a re-run never replays it. (Buzz's mechanism,
adopted wholesale — no client-side "did onboarding run" flag, the relay is
the source of truth.)

## 3. Readiness decides the opener's copy

A readiness probe in the Tauri backend answers "can a mention of @fez produce
a real reply on this machine?" by checking, in order:

1. **Claude Code harness** — installed (existing harness detection) *and*
   authenticated (shared-login model; same check `fez doctor` uses).
2. **Bundled pi + a key** — Chutes key or provider API key present in
   keychain custody (`fez-skill-env`), wired via the existing
   `wire_chutes_pi` path.
3. *(Future seam — not built now)* a funded hosted endpoint would be checked
   here; flipping it on must not change any other part of this design.

**Ready →** the opener ends with the live invitation ("try `@fez what can
you do?`"), and the app ensures the agent runner will actually answer — see
§4. The first real reply is the proof-of-life moment.

**Not ready →** the opener *is* the fallback card: it says @fez needs a
model, and carries an action that opens Settings → Agents. When auth later
appears (probe re-run on settings change and app focus), one follow-up
scripted line lands — marker `fez-welcome.awake.v1`, same idempotency —
telling the user @fez is ready and repeating the invitation. One line, once,
ever.

## 4. The mention must answer — or say why it can't

This claims the open ONBOARDING.md Tier-2 item "*@fez never answers, nothing
says why*". Desktop currently never starts an agent runner; the sentinel is
CLI-installed. Changes:

- When readiness passes, the app ensures a runner for @fez exists: if the
  sentinel is installed, defer to it; otherwise the app spawns/babysits the
  agent process for its own lifetime (scope limit: the app being closed
  meaning @fez is asleep is acceptable and true — the sentinel remains the
  always-on story).
- A mention of @fez that produces no reply within 60s surfaces as a **panel
  note** ("@fez is having trouble starting — check Agents"), never a
  fabricated message. Same honesty rule FirstRun already follows; timeout
  and copy mirror Buzz's degraded variants.

FirstRun's copy is updated to match reality: it already distinguishes
has-fez / no-agents; it gains the not-ready state (points at Settings →
Agents instead of suggesting a mention that will hang).

## Error handling

- **Relay spawn fails** (port taken, binary missing): the app falls back to
  in-memory-degraded UI it already has, and surfaces a BootError-style card
  with retry — never a silent empty app. Port conflict retries on an
  ephemeral port and persists the choice.
- **Opener publish fails** (relay not yet accepting): retried on next launch
  — the marker check makes retry safe.
- **Probe wrong** (says ready, reply never comes): covered by the 60s
  panel note; the probe is advisory, the timeout is the guarantee.

## Testing

- fez-evals: opener/awake marker idempotency (publish twice → one event);
  readiness matrix (harness-only / key-only / neither / both); relay
  spawn+claim (owner pubkey lands in NIP-11, Home bootstrap runs).
- Desktop: clean-macOS-user manual pass — DMG → onboard → scripted opener
  visible offline; with Claude Code logged in → real reply; with nothing →
  fallback card → add key → awake line lands once.
- Regression: invite path still widens the relay set; existing identities
  never get a local relay spawned.

## Out of scope (deliberate)

- **Funded free tier** — the readiness probe is the seam; nothing else may
  depend on its absence.
- **Remote reachability of the local relay** (multi-device beyond pairing;
  the relay stays loopback).
- **CLI `fez setup` parity** with this flow — follow-up.
- **Moderation/guest story for the hosted relay** — it stops being a
  default, which removes the urgency.

## Interaction with onboarding-tier1 (fez-47's branch)

Builds on: DEFAULT_RELAY single-home (`src/relay.ts`), fallible
`copy_agent_files`, notice toasts, FirstRun-for-every-empty-channel, harness
detection hardening. Supersedes: the hosted-relay *value* of DEFAULT_RELAY
for fresh identities. Claims: the "@fez never answers" Tier-2 item. The
tier-1 branch should land first; this work follows it.
