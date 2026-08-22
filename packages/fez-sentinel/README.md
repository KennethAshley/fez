# @fez/sentinel

The always-on half of fez. A standing service — no TUI, no window — that
watches the relay and keeps the fleet alive: it wakes sleeping agents on
DMs and mentions, delivers desktop notifications, and runs scheduled
tasks. Buzz's shape: the smart inner program is this service, and the
babysitter is whatever the operator has (launchd, herdr, a shell).

## What it watches

- **DM summons** — a gift-wrapped DM to a local persona wakes it
- **Mention summons** — `@name` from the owner or an attested sibling
  spawns the persona into the channel; for a repo channel it hands the
  agent its repo and (inside a `⑂` thread) its line, then invites its
  key before the process starts so the first roster-gated clone succeeds
- **Notifications** — DMs, mentions of the owner, failed agent turns
- **Schedules and reminders**, and any extension that opted into
  `background` (the branch-thread task, live blocks)

## Run

```bash
fez sentinel                 # foreground
fez sentinel-install         # as a launchd agent (macOS) — starts at login
```

The relay comes from your settings, not a baked-in pin; change it once
and the sentinel follows on restart. It signs invites and attestations
as you, so summoning introduces an agent to the workspace on your
authority.

## Safety

Summons authority is the owner and attested siblings only, chains are
depth-capped, and any string that reaches a spawned agent's shell (the
repo and line it is put on) is validated, not escaped — refused if it
is not plainly a name. A spawn that dies before its first turn reports
the reason into the channel it was summoned from, rather than dying
silent in a tab.
