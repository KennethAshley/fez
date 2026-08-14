# Ditto Agent

The "real" example agent. Records channel history, stores on Hippius, and can spawn sub-tasks for inference via Chutes.

## Capabilities

| Task Type | Description |
|-----------|-------------|
| `record` | Fetch Nostr events from a channel and store the transcript |
| `summarize` | Fetch channel history, send to Chutes for LLM summarization |
| `store` | Pack arbitrary data and upload to Hippius |

## Architecture

Not yet built — this is a design sketch, not a running example. There's no shared subprocess harness in Fez; an agent like this would be its own standalone process, same as `examples/echo-agent.ts`. If written in TypeScript (to match the rest of the SDK), it would use `Agent.create()`/`onTask()` directly instead of adapter modules calling into a harness:

```
┌─────────────┐
│ ditto-agent │  (standalone process — Agent.create() + onTask())
└──────┬──────┘
       │
       ├──► Nostr relay ──► subscribes for tasks, queries channel history
       │
       ├──► Hippius adapter ──► Store packed data (Bittensor SDK or HTTP API)
       │
       └──► Chutes adapter ──► LLM inference (Bittensor SDK or HTTP API)
```

## Adapters

Adapters would be modules that handle Bittensor subnet communication:

- `hippius.ts` — Upload/download to Hippius miners
- `chutes.ts` — Send prompts to Chutes inference miners

## Task Flow: `summarize`

1. Receive `KIND_AGENT_TASK` with `task_type: summarize`
2. Extract `channel_id` from `content.context`
3. Query relay for last N messages in channel
4. Pack messages into a prompt context
5. Call Chutes adapter for inference
6. Receive summary from Chutes
7. Optionally: store full transcript on Hippius
8. Publish `KIND_AGENT_RESULT` with summary + storage URL

## Configuration

```bash
export HIPPIUS_WALLET_SEED="<tao-wallet-seed>"
export CHUTES_API_KEY="<chutes-api-key>"
export DITTO_DEFAULT_RELAY="wss://relay.example.com"
```

## Running

```bash
# Once implemented — same pattern as examples/echo-agent.ts:
npx tsx src/cli.ts run examples/ditto-agent/ditto-agent.ts -r wss://relay.example.com -k ditto.key
```

## Bittensor Integration

The Hippius and Chutes adapters would wrap Bittensor's SDK, likely via its HTTP API rather than a native binding (Fez has no non-TypeScript component).
