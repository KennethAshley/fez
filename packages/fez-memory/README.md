# @fezchat/memory

**Shared team memory for agents.** Remember, recall, correct, and forget
facts over append-only, signed events on the relay.

Memory here is *not* private. Each `fez_remember` is its own event
(`kind:47210`, tagged with the channel), signed by the agent who wrote
it, so every agent and person in the channel reads the same team memory
and independent facts never overwrite each other. Both the desktop pane
and agent tools apply the workspace roster, bans, and moderator removals.
Channel names resolve only from owner-signed channel events.

This is the lightweight, fez-native answer to shared memory: **the relay
is the shared substrate, so sharing is the default** — the opposite of
per-agent memory silos. Default recall is keyword + recency. Optional
semantic recall uses `FEZ_EMBED_URL` (an OpenAI-compatible base URL),
`FEZ_EMBED_MODEL` (default `text-embedding-3-small`), and `FEZ_EMBED_KEY`.
When configured, memory text is sent to that endpoint and vectors are
stored with the signed events. Existing entries without vectors use
keyword fallback.

## Use

Install it, then declare it in a persona's `mcpServers`:

```markdown
---
harness: claude-code
mcpServers: [memory]
---
```

The agent gets these tools, signed with its own key:

- `fez_remember(channel, text, replaces?)`: save a fact, or correct the
  original memory id returned by recall. Text must contain 1–4000 characters.
- `fez_recall(channel, query?, limit?)`: read current facts and their original
  ids. Returns 20 by default, up to 100.
- `fez_forget(channel, memoryId)`: hide a fact from current recall.

Only the original author or a current workspace moderator may correct or
forget a fact. A correction is a new kind-47211 event referencing the
original kind-47210 id; newest authorized update wins, with the lowest
event id breaking timestamp ties. Empty correction text means forgotten.
Remembering again with `replaces` restores the same fact. **Forgetting is
not erasure:** signed history and plaintext remain on the relay. Older
clients that do not understand kind 47211 still show the original fact.

Recall searches the newest 500 memory events per relay. When that window
fills, the tool and pane warn that older facts may exist. A recent
correction retrieves its original even outside the window; correcting by
known original id also reads that fact directly. Relay failures produce
an explicit error (and Retry in the pane), never a claim of empty memory.

The channel tag organizes plaintext; privacy still depends on relay read
policy. Shared memory is separate from the agent's encrypted `core` and
`mem/` engrams.
