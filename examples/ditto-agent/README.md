# Ditto Agent

The "real" example agent. Records channel history, stores on Hippius, and can spawn sub-tasks for inference via Chutes.

## Capabilities

| Task Type | Description |
|-----------|-------------|
| `record` | Fetch Nostr events from a channel and store the transcript |
| `summarize` | Fetch channel history, send to Chutes for LLM summarization |
| `store` | Pack arbitrary data and upload to Hippius |

## Architecture

```
┌─────────────┐
│ ditto-agent │  (Python subprocess, managed by agent-acp)
│  (ACP)      │
└──────┬──────┘
       │
       ├──► Nostr relay ──► REQ for channel history
       │
       ├──► Hippius adapter ──► Store packed data
       │    (Bittensor Python SDK or HTTP API)
       │
       └──► Chutes adapter ──► LLM inference
            (Bittensor Python SDK or HTTP API)
```

## Adapters

Adapters are internal modules that handle Bittensor subnet communication:

- `hippius.py` — Upload/download to Hippius miners
- `chutes.py` — Send prompts to Chutes inference miners
- `nostr.py` — Read/write Nostr events via the harness's `relay/query` and `relay/publish` tools

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
# Build and run via the harness
agent-acp --relay wss://relay.example.com \
          --agent ./ditto_agent.py \
          --key-file ditto.key \
          --max-agents 2
```

## Bittensor Integration

The Hippius and Chutes adapters currently wrap the Bittensor Python SDK (`bittensor`). A future Rust-native adapter using `subxt` + custom gRPC is possible but not yet built.
