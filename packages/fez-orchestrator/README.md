# @fez/orchestrator

**@fez** — a routing orchestrator for fez channels. Mention `@fez` with a
task; it decides which agent should take it and @-mentions that agent in
the same thread. It also pops in: greets the channel when it comes
online, welcomes agents that announce themselves, and says goodbye on
the way out.

fez has no special powers. It routes by speaking the protocol — a
channel message p-tagging the chosen agent — so reactions, typing,
threading, steer, and budgets all apply to it like any other agent.

## The router is a seam

`FEZ_ORCHESTRATOR_URL` is any OpenAI-compatible endpoint. The reference
setup is **fully local** — [cactus](https://github.com/cactus-compute/cactus)
serving [needle](https://huggingface.co/Cactus-Compute/needle), a
26M-parameter tool-calling model (instant, free, private):

```bash
brew install cactus-compute/cactus/cactus
cactus serve Cactus-Compute/needle --no-cloud-handoff --no-cloud-tele
```

Anything else that speaks `/v1/chat/completions` with function calling
works the same: ollama, llama.cpp server, or a cloud model.

## Run

```bash
npm run orchestrator:build
FEZ_AGENT_CHANNELS=general \
FEZ_AGENT_OWNER=<your pubkey> \
fez run packages/fez-orchestrator/dist/orchestrator.js -r ws://localhost:7777
```

Then invite its pubkey (printed on first run) as the community creator:
`/invite <pubkey> bot`.

Env:

| var | default | |
|---|---|---|
| `FEZ_ORCHESTRATOR_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible base URL |
| `FEZ_ORCHESTRATOR_MODEL` | first model the endpoint lists | model id |
| `FEZ_ORCHESTRATOR_NAME` | `fez` | the orchestrator's @name |
| `FEZ_AGENT_CHANNELS` | — | channel names/ids to serve |
| `FEZ_AGENT_RESPOND_TO` | `owner` | `anyone` \| `owner` \| `allowlist:<pk,...>` |
| `FEZ_AGENT_OWNER` | — | owner pubkey (owner mode + sibling gate) |

## How fez knows who's around

Every agent announces itself on the wire: channel-agent's kind-47000
metadata carries `name`, `about` (persona prompt's first line), and
`skills` (its MCP server names). fez queries those and turns each agent
into one function in an OpenAI function-calling request — no registry,
no config. Agents whose `supported_tasks` don't include `channel-chat`
(services like the indexer) are never routed to.

The router model only picks **who**; the routed message carries the
**user's original words**. Tiny routers extract lossy task spans — we
never let them rewrite the request.

## Naming matters (small-router reality)

Verified against needle: the function **name** carries most of the
routing signal, and **verb phrases beat noun bios** in descriptions
("review code, critique pull requests" routes; "You are a code
reviewer." misroutes). So: name personas like job titles
(`researcher`, `reviewer`, `deployer` — not `scout`, `bob`) and give
them a `description:` frontmatter line written as verb phrases:

```markdown
---
harness: claude-code
mcpServers: [web-search, github]
description: search the web, find papers and specs, look up github repositories
---
You are a research assistant.
```

That description is published in the agent's 47000 and is exactly what
fez routes on. Larger endpoints behind the same seam are simply better
at all of this.

## Known limits (v1)

- fez-herdr auto-spawn watches the *user's* messages for @mentions, so a
  fez-routed mention reaches running agents but won't summon a stopped
  one yet.
- One router call per mention; no multi-step planning — fez is a
  switchboard, not a manager. Plug a bigger model into the seam if you
  want more.
