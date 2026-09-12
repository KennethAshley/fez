# @fezchat/sentinel

The optional headless runtime: it wakes sleeping agents, delivers notifications, and runs scheduled extension tasks without the desktop. In the current source implementation, the desktop owns its local agents and a bundled `fez-background` worker; desktop users do not need a sentinel service.

## What it watches

A gift-wrapped DM or an `@name` from the owner (or an attested sibling) wakes a persona into a channel. For a repo channel it hands the agent its repo, and inside a `⑂` thread its line, then rosters its key *before* the process starts so the first clone is not turned away. It also carries notifications, schedules, reminders, and any extension that asked for `background` life.

## Run

```bash
fez sentinel                 # foreground
fez sentinel-install         # a launchd agent (macOS), alive at login
```

Quit the desktop before starting the headless sentinel; a live desktop owner refuses a second runtime. Closing the desktop window keeps its local work running, while explicit Quit stops it.

The relay comes from your settings, not a baked-in pin. It signs invites and attestations as you — summoning introduces an agent on your authority.

## Safeguards

Summons authority is the owner and attested siblings only; chains are depth-capped; any name that reaches a spawned agent's shell is validated, not escaped — refused if it is not plainly a name. A spawn that dies before its first turn reports why into the channel, rather than dying quiet in a tab.
