# @fezchat/workflows

Rites that run themselves. Multi-agent follow-ups the model does not
have to *remember* to perform — "when researcher replies here, summon
@reviewer" fires on the reply *event*, whether or not any harness obeyed
its instructions. Ceremony made deterministic; Buzz's workflow engine,
decentralized.

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
  on: message          # message | reaction | schedule
  from: researcher     # agent name, "owner", or pubkey hex; absent = any member
  filter: "papers"     # message triggers: case-insensitive regex on the text
steps:
  - say: "@reviewer please review this: {{trigger.text}}"
  - wait_reaction:     # approval gate — Buzz's RequestApproval, reaction-flavored
      emoji: "✅"
      from: owner      # "owner" (default) | "any" (any member) | name | pubkey
      timeout: 24h
  - say: "Approved — @deployer ship it."
    if: 'trigger.text matches "release|deploy"'   # false skips the step, not the run
```

Schedule triggers run without a trigger message — the first `say`
starts a fresh thread:

```yaml
trigger:
  on: schedule
  cron: "0 9 * * 1-5"   # weekdays 9:00 (croner; 6-field with seconds also works)
  # or:  every: 4h      # simple interval (min 30s)
```

- `say` publishes into the trigger's thread; `@names` are p-tagged via
  the 47000 roster, so a say step **summons agents** exactly like a
  human mention. Template vars: `{{trigger.text}}`, `{{trigger.author}}`,
  `{{trigger.author_name}}`, `{{trigger.id}}`, `{{now}}`.
- `wait_reaction` suspends the run until the previous step's message
  gets the matching reaction from the allowed principal, then continues;
  on timeout the remaining steps are skipped and a notice is posted.
- `if:` on any step — Buzz's semantics: false **skips the step**, the
  run continues. The expression language is deliberately tiny (own
  evaluator, no eval, nothing to inject): strings/numbers/booleans,
  dotted vars, `== != < <= > >= && || !`, `matches` (case-insensitive
  regex), `contains`. An expression that errors (e.g. unknown variable)
  also skips — loudly, with the reason in the trace.
- Reaction triggers (`on: reaction`, optional `emoji:`) fire runs from
  reactions — "when someone 🚀s a message, do X".

## Judged conditions

The skeleton stays deterministic; the fez router's judge (TypeSafe Jev,
`/v1/judge`) answers the yes/no questions inside it. Every judgment is a
statement scored 0–1, logged and traced, thresholded by you. Set
`FEZ_JUDGE_URL` (router base, e.g. `https://…/v1`) and `FEZ_JUDGE_KEY`
(the router key); a workflow that uses any of these refuses to start
without them.

A workflow should add information the thread does not already have. An
earlier version of this example woke a writer to restate every research
finding in one sentence; it fired reliably and added nothing — a summary
of a good answer is noise at any bar. Plumbing that carries news is the
right shape: a blocker nobody may be watching, an approval, a schedule.

```yaml
name: blocked-work
channel: general
trigger:
  on: message
  from: researcher
  when: "the author says they could not finish, hit an obstacle, or need something before they can continue"
  when_at: 0.8          # default 0.8
steps:
  - dm:
      to: owner
      message: "{{trigger.author_name}} is blocked in #general: {{trigger.text}}"
  - wait_until:
      statement: "the message says the obstacle is resolved or the work is finished"
      from: researcher    # optional; default any member
      timeout: 4h         # default 24h
      at: 0.8             # default 0.8
  - dm: { to: owner, message: "{{latest.author_name}} is unblocked — see the thread." }
```

- `when:` filters message triggers by meaning where a regex would miss
  "can you look this over". One judge call per candidate; below the bar
  or on a judge failure the run does not fire, and the value is logged.
- `judge:` scores named statements about the run so far (trigger text
  plus the latest message a `wait_until` observed) into `judge.<name>`
  variables for later `if:` conditions. A judge failure skips the step,
  and conditions naming the missing variables then skip too.
- `wait_until:` suspends until a message in the thread satisfies the
  statement; the match becomes the anchor for later steps and fills
  `{{latest.text}}`, `{{latest.author_name}}`, `{{latest.id}}`. Timeout
  skips the rest and posts a notice. Pending waits persist like approval
  gates and re-arm after a restart with their remaining timeout.

## Silent summons

Coordination should not read as conversation. `wake:` starts an agent's
turn in the trigger's thread without posting anything: the templated
`text` travels to the agent as an owner-encrypted control frame (kind
20005, the same pipe as cancel) and the agent replies in the thread as if
the owner had asked. Prefer it to `say: "@agent …"` whenever the message
exists only to summon. Only the desktop's in-app host can send one — it
runs as the owner, and agents accept a wake only from their owner — so
the standalone service fails such a run instead of posting a summons.

```yaml
  - wake:
      agent: researcher
      # The agent already sees the thread; point at what is missing rather than pasting text.
      text: "@researcher the ask above requested sources — add links for the claims in your last message."
```

Anything a workflow does say (approval requests, timeout notices) carries
a `["workflow", <name>]` tag; the desktop renders those as **fez
workflows** with the workflow's name as a badge, never as the signer
speaking.

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
`step_skipped`, `waiting_approval`, `approved`, `timeout`, `done`)
tagged to the channel and trigger — Buzz's `workflow_runs` table, on
the wire, so any client can render what the automations did.

## Guard rails

- Triggers require channel membership — strangers never fire automations.
- Self-authored events never trigger (no self-loops); published messages
  carry `depth+1` and depth-capped events don't trigger — the same
  chain guard agents use, so workflow→agent→workflow chains stay bounded.
- Suspended approval gates and schedule last-fired state are in-memory:
  a restart drops pending gates and does not replay missed fires (same
  trade-off as Buzz's MVP). The trace trail shows what was pending.

## Not yet (Buzz has these; the vocabulary is designed to grow)

Webhooks (in AND out), `{{steps.ID.output.X}}` variables,
elevated-authority rules for exfiltrating actions.
