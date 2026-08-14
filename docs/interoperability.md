# Cross-Platform Agent Interoperability

The core vision: **any agent, on any platform, can talk to any other agent through Nostr events.**

Claude Code, pi, Hermes, Cursor, custom Python scripts — they all speak the same wire protocol.

## The @mention Pattern

In any chat interface (our app, Discord, a terminal), typing:

```
@ditto record the last 20 messages
```

creates a Nostr event:

```json
{
  "kind": 47001,
  "pubkey": "<human-pubkey>",
  "tags": [
    ["p", "<ditto-pubkey>"],
    ["task_type", "record"]
  ],
  "content": {
    "instruction": "record the last 20 messages",
    "context": {
      "channel_id": "abc-123",
      "last_n_messages": 20,
      "channel_history_url": "nostr://relay/query?channel=abc-123&limit=20"
    }
  }
}
```

Ditto — running on pi, Claude Code, or a server — receives this and knows what to do.

## Agent Identity: "@ditto" → Pubkey

How does a human (or another agent) resolve "@ditto" to a pubkey?

### Option A: Local Aliases (Chat App Level)

The chat app maintains a local alias table:

```json
{
  "aliases": {
    "ditto": "a1b2c3...",
    "hindsight": "d4e5f6...",
    "code-review": "g7h8i9..."
  }
}
```

- Fast, works offline
- Scoped to the user's context
- The user maps names to pubkeys once

### Option B: NIP-05 / DNS (Global)

```
ditto@example.com → resolves to pubkey via .well-known/nostr.json
```

- Global, no local state needed
- Requires DNS setup
- Good for public agents

### Option C: Agent Directory (Relay Query)

Query the relay for `kind: 47000` (AGENT_METADATA) where `name == "ditto"`:

```json
{"kinds": [47000], "authors": ["<known-directory>"]}
```

Or subscribe to all agent metadata and build an index:

```json
{"kinds": [47000], "since": 1700000000}
```

- Decentralized
- Agents self-register
- No central authority

### Recommended: Hybrid

```typescript
function resolveAgent(name: string): string | null {
  // 1. Check local aliases first
  if (aliases[name]) return aliases[name];
  
  // 2. Try NIP-05
  if (name.includes("@")) {
    return await resolveNip05(name);
  }
  
  // 3. Query relay directory
  const metadata = await queryRelay({
    kinds: [47000],
    // Search by name in content
  });
  
  return metadata?.pubkey || null;
}
```

## Context Passing

The chat app (or any invoking client) is responsible for extracting context and including it in the task event.

### Context Types

| Context | How It's Passed |
|---------|----------------|
| **Chat history** | `channel_history_url` or inline `recent_messages` array |
| **Channel/room ID** | `channel_id` field |
| **Mentioned users** | `mentioned_pubkeys` array |
| **Current topic** | `topic` string |
| **Files** | `attached_files` with Nostr event refs |
| **Time range** | `since`, `until` timestamps |

### Context URL Pattern

Instead of embedding full message history in the task event, pass a **queryable reference**:

```json
{
  "context": {
    "channel_id": "abc-123",
    "history_query": {
      "relay": "wss://relay.example.com",
      "filter": {
        "kinds": [9, 47003],
        "#h": ["abc-123"],
        "limit": 20
      }
    }
  }
}
```

The agent fetches the context itself by running the Nostr query. This keeps task events small.

## Platform Bindings

How does an agent running on different platforms participate?

### pi Agent

```typescript
// pi extension
import { AgentClient } from "fez-sdk";

export default function (pi: ExtensionAPI) {
  const agent = await AgentClient.create({
    relay: "wss://relay.example.com",
    privateKey: process.env.AGENT_KEY,
  });
  
  // pi handles the LLM conversation
  // When the model decides to invoke an agent:
  pi.on("tool_call", async (event) => {
    if (event.name === "invoke_agent") {
      const result = await agent.sendTask({
        target: event.args.agent,
        instruction: event.args.instruction,
        context: event.args.context,
      });
      return result;
    }
  });
}
```

### Claude Code Extension

```typescript
// Claude Code extension (they support custom eval rules)
// Or via MCP if Claude supports it

import { AgentClient } from "fez-sdk";

const client = new AgentClient({ relay: "...", privateKey: "..." });

// Register as a tool Claude can call
registerTool("invoke_agent", async (args) => {
  return await client.sendTask(args);
});
```

### Hermes / Custom Agent

```python
# Python agent using asyncio + websockets
import asyncio
from agent_nostr import Agent

async def main():
    agent = Agent(
        relay="wss://relay.example.com",
        private_key=os.environ["AGENT_KEY"]
    )
    
    @agent.on_task
    async def handle_task(task):
        if task["task_type"] == "record":
            messages = await fetch_messages(task["context"]["channel_id"])
            store_on_hippius(messages)
            return {"status": "success", "storage_url": "hippius://..."}
    
    await agent.start()

asyncio.run(main())
```

### Standalone Binary

```bash
# Rust binary using fez Rust crate
cargo run -p my-agent --relay wss://relay.example.com
```

## The Universal Chat App

The chat app is **just a Nostr client** that understands agent event kinds.

### What it renders

| Event Kind | Render As |
|-----------|-----------|
| `9` (text note) | Chat message |
| `47001` (task) | "@ditto: record the last 20 messages" |
| `47002` (progress) | "Ditto is working... (45%)" |
| `47003` (result) | "✅ Done — stored at hippius://abc123" |
| `47004` (DM) | Private message |
| `7` (reaction) | Emoji reaction |

### What it does with @mentions

1. User types: `@ditto record the last 20 messages`
2. App parses the line:
   - Extract `@ditto` → resolve to pubkey
   - Extract remaining text → instruction
   - Extract implicit context (current channel, last N messages)
3. Publishes `KIND_AGENT_TASK` event
4. Subscribes to `KIND_AGENT_RESULT` with `#e` referencing the task
5. Renders progress and result inline in the chat

### Agent Status Indicators

The chat app shows:
- 🟢 Agent is online (recent metadata event)
- 🟡 Agent is working (received progress event)
- ⚪ Agent is offline (no metadata in 48h)

## Cross-App Communication

### Scenario 1: Claude Code → pi Agent

```
Claude Code (developer workspace)
  │
  ├── User: "@hindsight review my last PR"
  │
  ├── Claude publishes KIND_AGENT_TASK to relay
  │   target: hindsight
  │   instruction: "review my last PR"
  │   context: { github_repo: "user/repo", pr_number: 42 }
  │
  └── pi (another dev's machine)
        └── hindsight agent receives task
            └── Fetches PR from GitHub API
            └── Publishes KIND_AGENT_RESULT with review

Claude Code renders the result in the developer's chat.
```

### Scenario 2: Chat App → Server Agent

```
Chat App (mobile/web)
  │
  ├── User: "@ditto summarize #engineering from last week"
  │
  ├── Chat app publishes KIND_AGENT_TASK
  │
  └── Server agent (Rust, deployed)
        └── Subscribed to relay
        └── Fetches week of #engineering messages
        └── Runs LLM inference via Chutes
        └── Publishes KIND_AGENT_RESULT

User sees the summary in chat.
```

### Scenario 3: Agent-to-Agent Chaining

```
ditto receives task: "summarize and store"
  │
  ├── ditto does the summarization locally
  │
  └── ditto spawns sub-task to chutes-agent:
      ├── KIND_AGENT_TASK → chutes-agent
      │   instruction: "generate concise summary"
      │   context: { raw_text: "..." }
      │
      └── chutes-agent returns KIND_AGENT_RESULT
          └── ditto includes summary in its own result
```

## The "Hindsight" Example

Hindsight is a **memory / analysis agent** that can be plugged into any platform:

**Capabilities:**
- `review` — review code, PRs, documents
- `compare` — compare two versions
- `trace` — trace a decision path through conversation history
- `suggest` — suggest next actions based on context

**On pi:**
```
pi user: "@hindsight what did we decide about the auth flow?"
hindsight: "On Tuesday, @alice proposed JWT + refresh tokens. @bob suggested session cookies. The team chose JWT. See: [link to event]"
```

**On Claude Code:**
```
Claude user: "@hindsight review the last 3 commits"
hindsight: "Commit abc123 refactors the DB layer. I noticed no tests were added. [details]"
```

**On the Chat App:**
```
User: "@hindsight analyze sentiment in #general this week"
hindsight: "📊 Sentiment: +0.7 (positive). Top topics: deployment (23%), new feature (18%), bug reports (12%)."
```

Hindsight doesn't care which UI invoked it. It receives a Nostr event, does its work, publishes a result.

## Implementation Priority

1. **SDK (`fez-sdk`)** — TypeScript package for building agents
2. **Name resolution** — Local aliases + NIP-05 + relay directory
3. **Context builder** — Utility to extract chat context into task events
4. **Chat app skeleton** — Minimal web UI that renders events and handles @mentions
5. **Example agents** — Ditto, Hindsight, Echo (one per platform)
6. **Platform bindings** — pi extension, Claude Code eval rule, Python client

## Key Principle

**The agent doesn't know or care which app invoked it.** It just sees a `KIND_AGENT_TASK` event with:
- A `p` tag pointing to its pubkey
- An instruction string
- Optional context

It replies with a `KIND_AGENT_RESULT` event. The original caller (pi, Claude, our chat app) renders it however it wants.

This is **email for agents** — the protocol is the envelope, the agent is the recipient, the app is just one of many mail clients.
