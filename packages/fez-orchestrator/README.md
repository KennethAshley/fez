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

`FEZ_ORCHESTRATOR_URL` is any OpenAI-compatible endpoint. Three ways to
fill it, in order of how much you want to install:

**Hosted (default — install nothing).** A fez-run router serving
Qwen3-0.6B. `@fez` works out of the box:

```markdown
url: https://137-184-135-188.sslip.io/v1
```

Your message text leaves your machine on every route, which is the
trade. If that's not acceptable, run one of the local options — the
seam is the same either way, and nothing else changes.

**Local, no brew.** Any OpenAI-compatible server with the same model:
[llama.cpp](https://github.com/ggml-org/llama.cpp) or ollama.

```bash
llama-server -m Qwen3-0.6B-Q4_K_M.gguf --jinja --reasoning off -c 2048
```

**Local, cactus + needle.** [cactus](https://github.com/cactus-compute/cactus)
serving [needle](https://huggingface.co/Cactus-Compute/needle), a 26M
tool-calling model — the smallest and fastest option, and macOS/ARM only:

```bash
brew install cactus-compute/cactus/cactus
cactus serve Cactus-Compute/needle --no-cloud-handoff --no-cloud-tele
```

## The seam is a URL *and* a profile

The request shape is part of the model choice, not separate from it.
Measured on the 97-case battery in `@fez/bench`:

| router | accuracy | over-routes |
| --- | --- | --- |
| needle 26M, its own shape | 71% | 8 |
| Qwen3-0.6B, needle's shape | 70% | 0 |
| Qwen3-0.6B, its own shape | **90%** | 1 |
| needle, Qwen3's shape | **20%** | 9 |

A bigger model buys nothing on its own — the gain is entirely in the
shape, and the shape that wins for one model *destroys* the other.
So each endpoint carries a profile:

- `needle` — no system message, no `tool_choice`, no sampling overrides.
- `tools` — short router system message, `tool_choice: required`,
  `temperature: 0`, `max_tokens: 96`.

It's auto-detected from the model id (anything matching `needle` gets
the needle profile), so existing local setups need no edit. Override
with `profile:` in the persona or `FEZ_ORCHESTRATOR_PROFILE`.

Two details worth keeping if you plug in your own model: **pin
temperature to 0** (llama.cpp defaults to 0.8, which moved bench scores
±4 points between identical runs), and **cap `max_tokens`** (general
models write a prose preamble before the tool call and will otherwise
ramble to the context limit — 10-12s per route on a small CPU; a cap of
96 scores identically to 512).

## Setup — a persona file, like any other agent

`~/.fez/personas/fez.md` is the primary config; env vars override it.

```markdown
---
harness: router
url: http://127.0.0.1:8080/v1
channels: [general]
owner: <your pubkey>
aliases: [orchestrator]
description: routes tasks to the right agent — mention @fez with anything
---
🎩 fez here. Mention @fez with a task and I'll bring in whoever's best for it.
```

- `harness: router` marks it as a standing service — fez-herdr won't try
  to auto-spawn it as a channel agent.
- The body is fez's greeting, in your voice (roster gets appended).
- `aliases` are extra @names that reach it; `description` is its 47000 about.
- `model:` pins the model id (otherwise auto-discovered from the endpoint).

## Run

```bash
npm run orchestrator:build
fez run packages/fez-orchestrator/dist/orchestrator.js -r ws://localhost:7777
```

Then invite its pubkey (printed on first run) as the community creator:
`/invite <pubkey> bot`.

Env overrides (each beats the persona file): `FEZ_ORCHESTRATOR_URL`,
`FEZ_ORCHESTRATOR_MODEL`, `FEZ_ORCHESTRATOR_PROFILE` (`needle` |
`tools`), `FEZ_ORCHESTRATOR_KEY` (bearer token, for endpoints that want
one), `FEZ_ORCHESTRATOR_NAME` (default `fez` — also picks which persona
file loads), `FEZ_AGENT_CHANNELS`, `FEZ_AGENT_RESPOND_TO` (`anyone` |
`owner` | `allowlist:<pk,...>`), `FEZ_AGENT_OWNER`.

Keep the token in the env var, not the persona file — a persona is a
plain markdown doc people paste into issues.

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
