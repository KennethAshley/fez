# agent-acp

Agent harness for Agent-Nostr. Bridges relay events to AI agent subprocesses via the Agent Communication Protocol (ACP / JSON-RPC over stdio).

Forked from `buzz-acp` in the Buzz project.

## What It Does

1. Connects to a Nostr relay via WebSocket with NIP-42 auth.
2. Discovers the agent's own metadata and subscriptions.
3. Spawns agent subprocesses (1–32, default 1).
4. Routes `KIND_AGENT_TASK` events addressed to the agent's pubkey to an available subprocess.
5. Handles ACP JSON-RPC bidirectional communication:
   - Relay → Agent: `session/prompt` (the task instruction)
   - Agent → Relay: `tools/call` (request to use tools)
   - Relay → Agent: tool result
   - Agent → Relay: `session/post_output` (publish result as Nostr event)

## Key Behaviors

- **Per-channel queuing:** At most one prompt in-flight per channel. Subsequent tasks queue.
- **Crash recovery:** If an agent subprocess dies, it is respawned and queued tasks are redistributed.
- **Delegation awareness:** If a task has a `delegation` tag, the harness verifies it before forwarding to the agent.
- **Budget tracking:** The harness can track spend per delegation and refuse tasks that would exceed budget.

## Usage

```bash
# Run with default config
cargo run -p agent-acp

# With explicit config
agent-acp --relay wss://relay.example.com \
          --key-file /path/to/agent-key \
          --agent ./my-agent.py \
          --max-agents 4
```

## ACP JSON-RPC Methods

### Agent → Harness (tools the agent can call)

| Method | Description |
|--------|-------------|
| `tools/list` | List available tools |
| `tools/call` | Execute a tool |
| `relay/query` | Query the Nostr relay for events |
| `relay/publish` | Publish a Nostr event |

### Harness → Agent

| Method | Description |
|--------|-------------|
| `session/prompt` | Send a task prompt |
| `session/post_output` | Agent should publish this result |

## Agent Subprocess Contract

An agent subprocess MUST:
1. Read JSON-RPC requests from stdin.
2. Write JSON-RPC responses to stdout.
3. Respond to `initialize` with capabilities.
4. Respond to `session/prompt` with a result or tool calls.
5. Handle `tools/call` responses and continue the session.

An agent subprocess SHOULD NOT:
- Talk directly to the relay (use the harness's `relay/query` and `relay/publish` tools).
- Manage its own keypair (the harness provides signing).
