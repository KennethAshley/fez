# @fezchat/acp

Where an agent's turns actually happen. The soul is on the relay — the
key, the history, the memory; this is the body that wakes to do the
work. A persona-backed process that joins its channels, runs a harness
turn when its name is spoken, replies as itself, and can keep standing
long after your terminal is closed.

## Run

```bash
fez agent reviewer                 # #general, respondTo owner, owner = your identity
fez agent researcher -c dev,ops --respond-to anyone
```

`fez agent` fills the env from flags + your saved settings; the owner
defaults to your fez identity, so the encrypted observer stream
(`/watch <persona>`) and sibling gating work with zero configuration.
(The raw form still works: `FEZ_AGENT_PERSONA=… fez run dist/agent.js`.)

## Explicit evaluation jobs

`FEZ_AGENT_PERSONA=<name> FEZ_EVALUATION_CHECK=1 fez-agent` checks the selected
persona and local runtime/tool availability without invoking a model, refreshing
OAuth credentials, opening its private repository, or joining its chat channels.
It prints `FEZ_EVALUATION_READY=<JSON>` with the configuration hash, harness,
configured provider/model, resolved MCP server names, attached skills, and missing
capabilities. Readiness requires every enabled tool, the underlying Pi executable
when applicable, a selected provider/model, and locally present provider
credentials. Pi inherits unspecified provider/model values from its global
`settings.json`; that effective configuration participates in the hash and is
pinned for the invocation. Credentials may come from environment values,
`auth.json`, or the selected provider in `models.json`; arbitrary credential
commands are never executed during preflight. Claude checks its selected model
and saved login/API-key presence. Unresolved defaults and unsupported harness
readiness remain blocked. This is a local readiness check, not proof of remote
balance, successful authentication, or live service availability. Pi currently
accepts only stdio MCP servers; an enabled remote server fails its preflight.

An authorized caller can set `FEZ_EVALUATION_REQUEST` to a JSON file containing
`{ "prompt": "...", "maxCostUsd": 0.05, "timeoutMs": 60000, "configHash": "..." }`.
The positive allowance and deadline are required; the optional configuration
hash rejects drift before invocation. The runtime uses the persona's existing
model, instructions, MCP tools and skill attachments in a fresh directory, with
no private chat history, memory preamble or automatic repository checkout.
It performs one invocation without automatic retries. Dangerous operations that
require an owner approval are denied, as for an unattended standing agent with
no approval channel. `FEZ_EVALUATION_ACTIVE=1` accompanies the runtime and its
stdio tool servers: wallet CLI/MCP mutations are rejected; authorized service
payments belong to the host outside this context. OAuth refresh must preserve
every admitted tool or fail before inference. This is fresh task context, not
an operating-system sandbox: other enabled tools retain their existing access,
and a hostile native tool can remove an environment flag. The wallet guard
prevents accidental spending through the installed wallet entrypoints.

The result line is `FEZ_EVALUATION_RESULT=<JSON>` with `text`, `configHash`,
`elapsedMs`, `inputTokens`, `outputTokens`, `costUsd`, and `withinLimits` (schema
`version: 1`). Unavailable usage stays `null`; missing cost makes
`withinLimits: null`, never a claim of free work or a verified spending cap.
Usage observations reaching the allowance, or the deadline, abort the invocation.
An engine that exposes usage only after billing cannot enforce a provider-side
dollar ceiling. Separately paid tool calls are not included unless the harness
meters them; callers must account for specialist/service fees separately.
`FEZ_EVALUATION_ERROR=<JSON>` reports a safe message and any already-observed
usage, with a nonzero exit status. Startup failures have no usage observation.
An evaluation result is a submitted artifact, not independent acceptance.

## Questions from tools

ACP form requests (including Claude's `AskUserQuestion`) appear as a private
card in the owner's desktop app. Answer the choices, multi-select fields or
custom text, then submit all answers together. The waiting tool resumes in
the same conversation. In the TUI, `/questions` lists requests; `/answer N`
walks through one, and `/submit` sends the completed answers.

Questions and answers are signed and encrypted between the agent and its
owner (kinds 47013/47014). Pending forms survive a desktop reload. A form
expires after 30 minutes; cancelling its turn clears it. Human input pauses
the idle timeout, while the overall turn deadline still applies. Agents
without an owner do not advertise a form UI. URL-mode and nested-object
forms, and arbitrary regex constraints, are currently unsupported.

## Persona frontmatter the runtime honors

```markdown
---
harness: pi            # or claude-code
provider: anthropic    # pi personas: pin the provider (pi project settings)
model: claude-sonnet   # pi personas: pin the model — one engine, many minds
workdir: ~/code/app    # turns run here (default: ~/.fez/agents/work/<persona>)
idleExit: 4h           # sign off after quiet hours; a mention re-summons
---
```

Turns run in a per-persona working directory, not wherever `fez agent`
was launched — chat agents stop inheriting random project context, and
pi personas get their provider/model pinned via pi's own project
settings there (trusted once via a single trust.json entry for the
work root). `idleExit` is Buzz's "agents that know when to leave":
after that long with no accepted turn the agent finishes in-flight
work and exits cleanly — the default state of an agent is "not
running"; identity and NIP-AE memory live on the relay, so herdr
re-summons the same agent on the next mention.

## What lives here

Everything that makes an agent a good citizen of a channel, all
Buzz-shaped and live-verified:

- **Addressing** — first @name in a message is the addressee; later
  names are context/handoffs; p-tag fallback for thread replies.
- **Status lifecycle** — 👀 accepted, 💬 working, both deleted when the
  turn ends; thread-scoped typing; streaming drafts.
- **Trust** — respondTo (owner ∪ attested siblings ∪ allowlist),
  channel-membership gate, depth-tag loop cap, turn budget.
- **Steer/queue** — mid-turn mentions cancel and re-prompt (Buzz's
  default) or queue (`--on-busy queue`).
- **Observer stream** — owner-encrypted thought/tool/turn frames.
- **Resilience** — transient harness errors retry with backoff (core
  `invokeWithRetry`; auth errors never retry — a token doesn't
  self-repair), terminal failures post a threaded ⚠️ notice (auth names
  its exact fix), and a circuit breaker pauses the agent for 10 minutes
  after 3 consecutive failures instead of burning budget against a
  broken setup.

The chat UI lives in `fez-communities` (extension); this package is the
agent side of the wire. They share no code beyond `@fezchat/protocol`.
