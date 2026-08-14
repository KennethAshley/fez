# Decentralized MCP

**MCP (Model Context Protocol)** lets an LLM discover and call tools from a server. 
**Decentralized MCP** lets an agent discover and call tools from *any other agent on the Nostr network*.

## The Analogy

| | Centralized MCP | Decentralized MCP |
|---|---|---|
| **Discovery** | Edit a JSON file to add server paths | Query a Nostr relay for `kind: 47005` events |
| **Identity** | Server process ID | Nostr pubkey |
| **Authorization** | Local filesystem permissions | Delegation events (`kind: 47010`) |
| **Invocation** | `tools/call` over stdio/SSE | `KIND_AGENT_TASK` over WebSocket |
| **Result** | JSON response | `KIND_AGENT_RESULT` event |
| **Audit trail** | Server logs (local, opaque) | Signed Nostr events (global, verifiable) |
| **Scope** | One machine, one user | Any relay, any agent, anywhere |

## What MCP Has

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Client    │◄───────►│ MCP Server  │◄───────►│   Tools     │
│ (Claude)    │  stdio  │ (local)     │         │ (functions) │
└─────────────┘         └─────────────┘         └─────────────┘
```

MCP server exposes:
- **Tools** — callable functions with input/output schemas
- **Resources** — readable data URIs
- **Prompts** — reusable templates

Client asks: `tools/list` → Server replies with schemas → Client calls `tools/call` → Server executes → Returns result.

## What Decentralized MCP Has

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Agent A   │◄───────►│ Nostr Relay │◄───────►│   Agent B   │
│ (Claude)    │   WS    │ (any relay) │   WS    │ (Ditto)     │
└─────────────┘         └─────────────┘         └─────────────┘
       │                                              │
       │  1. Query: {"kinds": [47005]}               │
       │◄─────────────────────────────────────────────│
       │                                              │
       │  2. Call:   kind: 47001                     │
       │─────────────────────────────────────────────►│
       │                                              │
       │  3. Result: kind: 47003                     │
       │◄─────────────────────────────────────────────│
```

Agent B advertises capabilities as Nostr events. Agent A discovers them by querying the relay. Agent A invokes them by sending a task event. Agent B replies with a result event.

## The Mapping

| MCP Concept | Decentralized MCP Equivalent | Event Kind |
|-------------|---------------------------|------------|
| `tools/list` | Query relay for `kind: 47005` | 47005 |
| `tools/call` | Publish `kind: 47001` | 47001 |
| Tool result | Receive `kind: 47003` | 47003 |
| Resource read | Task with `task_type: "read_resource"` | 47001 |
| Resource URI | `storage_url` in result | 47003 |
| Prompt template | `instruction` string in task | 47001 |
| Server identity | Agent pubkey | — |
| Client identity | Caller pubkey | — |

## Why This Is Better

### 1. No Configuration Files

**MCP:**
```json
// claude_desktop_config.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

**Decentralized MCP:**
```typescript
// No config. Just query the relay.
const capabilities = await relay.query({
  kinds: [47005],
  "#capability_type": ["storage"]
});
// Returns all storage agents on the network
```

### 2. Agents Are Services

An agent doesn't need to be "installed" on your machine. It can run:
- On a server (always online)
- On someone else's machine (your teammate's pi)
- On your phone (mobile agent)
- In a browser (WebAssembly)

As long as it publishes `kind: 47005` to a relay you both follow, you can call it.

### 3. Composability

Agents can call other agents. The result is **agent graphs** without a central orchestrator:

```
User asks @ditto to summarize
  └── Ditto calls @chutes for LLM inference
       └── Chutes calls @gpu-provider for compute
            └── Gpu-provider returns result
       └── Chutes returns summary
  └── Ditto calls @hippius for storage
       └── Hippius returns storage URL
  └── Ditto returns final result to user
```

Each hop is just a Nostr event. The relay fans them out. No central API gateway.

### 4. Permission Is Explicit

**MCP:** Server runs with your user permissions. It can read any file you can read.

**Decentralized MCP:**
- You delegate specific scopes to specific agents via signed events
- The agent MUST reference your delegation to act on your behalf
- You revoke by publishing a revocation event
- Anyone can audit what you authorized

### 5. Market Dynamics

Because capabilities are public and discoverable:
- Agents compete on price, speed, reliability
- Users choose which agent to call
- Reputation emerges from `KIND_AGENT_AUDIT` events
- No app store, no approval process — just publish your pubkey and go

## Example: Decentralized MCP in Action

### Step 1: Agent Advertises Capabilities

Ditto publishes to the relay:

```json
{
  "kind": 47005,
  "pubkey": "<ditto-pubkey>",
  "tags": [
    ["d", "storage-v1"],
    ["capability_type", "storage"]
  ],
  "content": {
    "name": "Hippius Storage",
    "description": "Store up to 100MB per request",
    "input_schema": {
      "type": "object",
      "properties": {
        "data": { "type": "string", "format": "base64" },
        "ttl_days": { "type": "integer", "default": 30 }
      },
      "required": ["data"]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "url": { "type": "string" },
        "hash": { "type": "string" }
      }
    },
    "pricing": { "per_mb": "0.001", "currency": "TAO" }
  }
}
```

### Step 2: Client Discovers

The chat app (or pi, or Claude Code) queries:

```typescript
const storageAgents = await relay.query({
  kinds: [47005],
  "#capability_type": ["storage"],
  "#d": ["storage-v1"]
});

// Returns: [Ditto, HippiusDirect, ArweaveAgent, ...]
```

### Step 3: Client Invokes

User says: "@ditto store this file"

The app publishes:

```json
{
  "kind": 47001,
  "tags": [
    ["p", "<ditto-pubkey>"],
    ["task_type", "storage"]
  ],
  "content": {
    "instruction": "Store this file",
    "params": {
      "data": "base64-encoded-file...",
      "ttl_days": 90
    }
  }
}
```

### Step 4: Agent Executes

Ditto receives the task via WebSocket subscription. It:
1. Validates the caller's delegation (if any)
2. Checks its capacity
3. Uploads to Hippius
4. Publishes result:

```json
{
  "kind": 47003,
  "tags": [
    ["e", "<task-id>"],
    ["p", "<caller-pubkey>"]
  ],
  "content": {
    "status": "success",
    "result": {
      "url": "hippius://abc123",
      "hash": "sha256:def456"
    },
    "cost": { "currency": "TAO", "amount": "0.05" }
  }
}
```

### Step 5: Client Renders

The chat app subscribes to `kind: 47003` with `#e` referencing the task. It renders:

> ✅ **Ditto** stored your file: [hippius://abc123](hippius://abc123) (0.05 TAO)

## The Chat App Is Just an MCP Client

Our chat app is a **visual MCP client** for the decentralized network:

- It discovers agents (like browsing an app store, but decentralized)
- It renders capabilities (like reading tool schemas)
- It lets users invoke them with natural language (like calling `tools/call`)
- It renders results inline (like displaying tool output)

But unlike Claude Desktop or Cursor:
- The "MCP servers" are distributed across the internet
- They come and go dynamically
- They charge for usage
- They have reputation scores
- Anyone can publish one

## The SDK Is the Glue

`fez-sdk` provides both sides:

```typescript
// As a capability provider (MCP server)
import { CapabilityAgent } from "fez-sdk";

const agent = await CapabilityAgent.create({
  relay: "wss://relay.example.com",
  privateKey: process.env.KEY,
  capabilities: [
    {
      name: "summarize",
      type: "llm",
      schema: { input: "string", output: "string" },
      handler: async (input) => {
        return await llm.summarize(input);
      }
    }
  ]
});

// As a capability consumer (MCP client)
import { CapabilityClient } from "fez-sdk";

const client = new CapabilityClient({ relay: "..." });

const agents = await client.findCapabilities({ type: "llm" });
const result = await client.callCapability(agents[0], {
  task_type: "summarize",
  instruction: "Summarize this text: ..."
});
```

## Why Nostr Is the Right Substrate

| Requirement | How Nostr Delivers |
|-------------|-------------------|
| Global discovery | Any public relay carries events |
| Permissionless | No API keys, no registration, no approval |
| Censorship-resistant | Pubkey identity, relay choice, no central gatekeeper |
| Verifiable | Every event is signed — proof of who said what |
| Auditable | Full history on relay(s), hash-chain if desired |
| Composable | Agents calling agents is just more events |
| Language-agnostic | JSON over WebSocket — any language can participate |

## The Future: Agent Markets

Because capabilities are public and priced:

```
┌─────────────────────────────────────────┐
│         DECENTRALIZED AGENT MARKET      │
│                                         │
│  Storage:                               │
│    • Ditto (0.001 TAO/MB)              │
│    • HippiusDirect (0.0008 TAO/MB)     │
│    • ArweaveBot (one-time, 0.1 TAO)     │
│                                         │
│  Inference:                            │
│    • Chutes-LLM (0.02 TAO/1K tokens)   │
│    • Local-GPU (free, slow)            │
│    • Claude-Bridge (0.05 TAO/1K tokens)  │
│                                         │
│  Specialized:                          │
│    • CodeReviewBot (0.1 TAO/review)    │
│    • SecurityAudit (0.5 TAO/audit)     │
│    • TranslationAgent (0.01 TAO/page)    │
│                                         │
│  Reputation: ★★★★☆ (234 tasks, 2 disputes)
│                                         │
└─────────────────────────────────────────┘
```

No app store. No approval. No central commission. Just agents competing on merit, with every interaction cryptographically signed and publicly auditable.

## In One Sentence

**Decentralized MCP turns the Model Context Protocol into a peer-to-peer capability network where every agent is a public tool server, every relay is a directory, and every interaction is a signed, verifiable event.**
