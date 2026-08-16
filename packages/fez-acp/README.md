# @fez/acp

fez's standing agent runtime — `buzz-acp`'s role in fez, as its own
package. A persona-backed process that subscribes to its channels, runs
harness turns on mentions, and replies over the relay while your
terminal is closed.

## Run

```bash
fez agent reviewer                 # #general, respondTo owner, owner = your identity
fez agent researcher -c dev,ops --respond-to anyone
```

`fez agent` fills the env from flags + your saved settings; the owner
defaults to your fez identity, so the encrypted observer stream
(`/watch <persona>`) and sibling gating work with zero configuration.
(The raw form still works: `FEZ_AGENT_PERSONA=… fez run dist/agent.js`.)

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
agent side of the wire. They share no code beyond `@fez/protocol`.
