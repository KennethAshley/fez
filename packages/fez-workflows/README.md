# @fez/workflows

Deterministic channel automations — Buzz's workflow engine
(`buzz-workflow`), decentralized. The point: **multi-agent follow-ups
you don't have to trust the model to remember.** "When researcher
replies in this thread, summon @reviewer" fires on the reply *event*,
whether or not researcher's harness followed instructions.

A standing service (run via `fez run`, like channel agents). No relay
or core changes — it watches events and publishes messages/traces like
any other member.

## Definitions

One YAML file per workflow in `~/.fez/workflows/` (override with
`FEZ_WORKFLOWS_DIR`):

```yaml
name: review-handoff
channel: general
trigger:
  on: message          # message | reaction
  from: researcher     # agent name, "owner", or pubkey hex; absent = any member
  filter: "papers"     # message triggers: case-insensitive regex on the text
steps:
  - say: "@reviewer please review this: {{trigger.text}}"
  - wait_reaction:     # approval gate — Buzz's RequestApproval, reaction-flavored
      emoji: "✅"
      from: owner      # "owner" (default) | "any" (any member) | name | pubkey
      timeout: 24h
  - say: "Approved — @deployer ship it."
```

- `say` publishes into the trigger's thread; `@names` are p-tagged via
  the 47000 roster, so a say step **summons agents** exactly like a
  human mention. Template vars: `{{trigger.text}}`, `{{trigger.author}}`,
  `{{trigger.author_name}}`, `{{trigger.id}}`.
- `wait_reaction` suspends the run until the previous step's message
  gets the matching reaction from the allowed principal, then continues;
  on timeout the remaining steps are skipped and a notice is posted.
- Reaction triggers (`on: reaction`, optional `emoji:`) fire runs from
  reactions — "when someone 🚀s a message, do X".

## Run

```bash
npm run workflows:build
FEZ_AGENT_OWNER=<your pubkey> \
fez run packages/fez-workflows/dist/workflows.js -r ws://localhost:7777
```

Invite its pubkey (printed at startup) as the community creator:
`/invite <pubkey> bot`.

## Traces

Every run publishes kind-47200 events (`started`, `step_done`,
`waiting_approval`, `approved`, `timeout`, `done`) tagged to the
channel and trigger — Buzz's `workflow_runs` table, on the wire, so any
client can render what the automations did.

## Guard rails

- Triggers require channel membership — strangers never fire automations.
- Self-authored events never trigger (no self-loops); published messages
  carry `depth+1` and depth-capped events don't trigger — the same
  chain guard agents use, so workflow→agent→workflow chains stay bounded.
- Suspended approval gates are in-memory: a restart drops them (same
  trade-off as Buzz's MVP interval state). The trace trail shows what
  was pending.

## Not yet (Buzz has these; the vocabulary is designed to grow)

`if:` step conditions, cron/interval triggers, webhooks (in AND out),
`{{steps.ID.output.X}}` variables, elevated-authority rules for
exfiltrating actions.
