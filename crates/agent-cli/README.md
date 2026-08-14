# agent-cli

Orchestrator CLI for Agent-Nostr. The human's interface to their agent fleet.

## Commands

| Command | Description |
|---------|-------------|
| `delegate` | Publish `KIND_AGENT_DELEGATION` to authorize an agent |
| `revoke` | Publish `KIND_AGENT_REVOKE` to invalidate a delegation |
| `task` | Publish `KIND_AGENT_TASK` to request work |
| `cancel` | Publish `KIND_AGENT_CANCEL` to stop an in-flight task |
| `inspect` | Query relay for an agent's metadata and capabilities |
| `watch` | Subscribe to events for your pubkey and stream them to stdout |
| `audit` | Query audit events for a given agent or delegation |
| `keygen` | Generate a new Nostr keypair |

## Example: Delegate and Task

```bash
# Generate a keypair (or load from env)
export AGENT_PRIVATE_KEY=$(agent-cli keygen)

# Inspect an agent before delegating
agent-cli inspect --pubkey <agent-pubkey> --relay wss://relay.example.com

# Delegate authority
agent-cli delegate \
  --agent <agent-pubkey> \
  --scope tasks_write \
  --scope storage_read \
  --expires "2025-12-31T23:59:59Z" \
  --relay wss://relay.example.com

# Send a task
agent-cli task \
  --agent <agent-pubkey> \
  --type summarize \
  --instruction "Summarize channel abc-123" \
  --relay wss://relay.example.com

# Watch for results
agent-cli watch --relay wss://relay.example.com
```

## Configuration

| Env Var | Description |
|---------|-------------|
| `AGENT_PRIVATE_KEY` | Nostr private key (hex or nsec) |
| `AGENT_RELAY_URL` | Default relay to connect to |
| `AGENT_LOG_LEVEL` | tracing log level |
