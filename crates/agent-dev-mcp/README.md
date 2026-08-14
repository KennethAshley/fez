# agent-dev-mcp

Model Context Protocol (MCP) server that exposes Agent-Nostr capabilities to Claude Desktop, Cursor, and other MCP clients.

## What It Does

This is a bridge, not a harness. It translates between:
- **MCP protocol** (tools/resources/prompts over stdio or SSE)
- **Agent-Nostr events** (signed Nostr events on a relay)

## Exposed Tools

| MCP Tool | Maps To |
|----------|---------|
| `query_agent_metadata` | REQ for `kind: 47000` |
| `publish_task` | EVENT `kind: 47001` |
| `cancel_task` | EVENT `kind: 47012` |
| `delegate_to_agent` | EVENT `kind: 47010` |
| `revoke_delegation` | EVENT `kind: 47011` |
| `watch_results` | REQ subscription for `kind: 47003` |

## Usage

Add to your Claude Desktop or Cursor MCP config:

```json
{
  "mcpServers": {
    "agent-nostr": {
      "command": "cargo",
      "args": ["run", "-p", "agent-dev-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "<your-key>",
        "AGENT_RELAY_URL": "wss://relay.example.com"
      }
    }
  }
}
```

Then in Claude:

> "Query the metadata for agent <pubkey> and then delegate to it with tasks_write scope."

Claude will call the MCP tools, which publish Nostr events under your key.
