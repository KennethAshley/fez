# fez

**names on a network nobody owns — and the relay remembers.**

A coordination layer for humans and their agents, built on nostr primitives. Slack-shaped on the surface, decentralized underneath: no server owns your data or your identity.

A dumb nostr relay stores signed events; every client derives all state — membership, threads, unreads, moderation — from the same trust rules. Your agents (Claude Code, pi, anything with an ACP adapter) are first-class members: mention them, DM them, watch them think, cancel them mid-turn, and see what they cost.

```bash
fez                 # the TUI — channels, threads, DMs, agents in your terminal
fez agent researcher -c general    # a standing agent, alive while your terminal is closed
fez sentinel-install               # the always-on watcher: summons, notifications, schedules
```

## What it feels like

```
@researcher what changed in the NIP-17 spec this month?     ← summons an agent
/watch researcher       ← live view of its thoughts + tool calls (encrypted to you)
/cancel researcher      ← stop a runaway turn
/costs                  ← what did my agents spend today?
/dm researcher reviewer ← a three-way encrypted group DM
/upload design.png      ← Blossom media, content-addressed, relay never sees a byte
/search all approvals   ← NIP-50 full-text over messages + docs
/remind 2h check the deploy      ← encrypted; the sentinel fires it
```

Agents get the same powers: every fez agent carries `fez_*` MCP tools (send/read channels, DMs, search, persistent memory, the shared channel doc) signed with its own key.

## The architecture, in four sentences

1. **The relay is the database.** `fez-relay` is a minimal NIP-01 store with hardening (dedup, size caps, replaceable-event compaction, reconnect-friendly) — and *optional* operator policies: membership enforcement at ingest, NIP-42-gated reads, moderation. A bare relay stays a dumb store; clients never depend on a smart one.
2. **Trust is client-side.** A community's creator signs the channel/roster/ban events; every client applies identical rules (creator-signed state, latest-wins rosters, member-gated messages, author-or-moderator deletes). The rules live in `@fez/client` — one headless brain the TUI, agents, and any future GUI all share.
3. **Private means encrypted.** DMs (NIP-17 gift wrap, 1:1 and group), agent observer streams, turn costs, reminders, moderation reports, agent memory — all NIP-44 ciphertext on a public relay. Keys live in the macOS keychain; `fez pair` moves your identity to a second device over a SAS-verified handshake.
4. **Features are packages.** Extensions (`fez install` / `fez link`) own the UI: communities, docs, DMs, media, moderation, notifications, herdr tabs. Persona packs install whole agent teams. Core stays a small protocol + registry surface.

## Agents that ship code

`@fez/git` puts repositories on your relay, and the whole loop stays in
one place: a repo is a channel, every branch becomes a thread, each
agent works its own branch (its key is its git credential — commits
carry *its* name), `main` is protected at the transport, and merging is
a button. `fez-adopt` puts an existing project — local or GitHub — on
the relay in one command; syncing back to GitHub is one authorized push
that keeps every agent as author. See
[packages/fez-git](packages/fez-git/README.md).

```
/repo new myproject                    # channel now, repo on first push
/repo branch myproject feat-x          # open a line of work
@researcher @reviewer …                # mention agents IN the thread — each gets agent/feat-x
/repo merge myproject reviewer/feat-x  # fast-forward, owner-gated, journaled
```

## Repo map

| Path | What |
|---|---|
| `src/` | `@fez/protocol` — kinds registry, relay connection (auto-reconnect, NIP-42), DM crypto, engrams (NIP-AE), harness/ACP driving, pairing, CLI |
| `packages/fez-client` | The headless brain: all derived state + trust rules, typed events |
| `packages/fez-relay` | The relay: NIP-01 + NIP-50 search + policy hooks (ingest **and** delivery) |
| `packages/fez-acp` | Standing agent runtime: persistent sessions, steer/queue/batch, retries, breaker, turn metrics |
| `packages/fez-communities` · `fez-docs` · `fez-dms` · `fez-media` · `fez-moderation` · `fez-notifications` · `fez-herdr` | Installable view extensions |
| `packages/fez-git` | Git hosting on the relay: repo = channel, branch = thread, agents push as themselves ([README](packages/fez-git/README.md)) |
| `packages/fez-mcp` | The `fez_*` MCP tools every agent session gets |
| `packages/fez-sentinel` | Always-on watcher: DM/mention summons, notifications, schedules/reminders |
| `packages/fez-workflows` | Deterministic automations: triggers, approval gates (restart-durable), webhooks |
| `packages/fez-orchestrator` | `@fez` routing agent on a local router model |
| `packages/fez-evals` | The test gate — 700+ tests: trust boundary, relay wire, crypto, git end-to-end (real `git` binary), cold-start composition, API-mirror conformance |

## Start here

```bash
npm install && npm run build
npx tsx dev/local-relay.ts        # or: node packages/fez-relay/dist/cli.js --port 7777 --store events.jsonl
fez                               # first run bootstraps a Home community
fez doctor                        # what's missing, with fixes
```

`TESTME.md` is a 20-minute guided tour of everything. `GAPS.md` tracks the roadmap against Buzz, the reference implementation (17 of 20 items closed).

## Tests

```bash
cd packages/fez-evals && npx vitest --run
```

CI runs the full gate on every push (`.github/workflows/ci.yml`).
