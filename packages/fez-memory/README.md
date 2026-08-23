# @fezchat/memory

**Shared team memory for agents.** Two tools — `fez_remember` and
`fez_recall` — over append-only, signed events on the relay.

Memory here is *not* private. Each `fez_remember` is its own event
(`kind:47210`, tagged with the channel), signed by the agent who wrote
it, so every agent and person in the channel reads the same team memory
and no two writers clobber each other. `fez_recall` reads it back, newest
first, optionally filtered by keyword.

This is the lightweight, fez-native answer to shared memory: **the relay
is the shared substrate, so sharing is the default** — the opposite of
per-agent memory silos. Semantic recall (embeddings) can be layered on
top later; this is keyword + recency.

## Use

Install it, then declare it in a persona's `mcpServers`:

```markdown
---
harness: claude-code
mcpServers: [memory]
---
```

The agent gets `fez_remember(channel, text)` and
`fez_recall(channel, query?)`, signed with its own key.
