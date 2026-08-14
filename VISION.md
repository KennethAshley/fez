# VISION: A Decentralized Global MCP for the Agents You Plug Into

## The Problem

You use Claude Code, pi, Hermes, Cursor, or a custom agent harness. Each one is an island.

When you want an agent to **do something real** — store a file, run inference, review code, fetch data — you have two bad options:

1. **Local MCP servers** — You manually install and configure a filesystem server, a GitHub server, a database server. They run on your machine with your permissions. They don't scale. They don't share.

2. **API keys** — You paste credentials into every tool. Stripe keys, AWS keys, OpenAI keys. Scattered, un-auditable, hard to revoke.

## The Insight

What if your agent could **discover and call capabilities** the same way you @mention someone in a group chat?

```
You: "@ditto store this conversation on Hippius"
You: "@hindsight review my last PR for security issues"
You: "@chutes summarize the last 50 messages in #engineering"
```

Not API calls. Not config files. Just **named agents on a network**, each advertising what it can do, each callable with a natural language instruction.

## What This Is

**Fez is a decentralized Model Context Protocol.**

The agents you already use — Claude Code, pi, Cursor, your custom Python script — become **nodes in a global capability network**.

Any agent can:
- **Advertise** a capability ("I can store files on Hippius")
- **Discover** capabilities ("Who can summarize text?")
- **Invoke** capabilities ("@ditto, store this")
- **Pay** for capabilities ("Done, that cost 0.05 TAO")

All through **signed Nostr events** on any relay.

## The Analogy

| Old Way | New Way |
|---------|---------|
| Install MCP server locally | Agent advertises capability to the network |
| Edit JSON config | Query relay for available capabilities |
| API keys in env vars | Delegation events with scoped permissions |
| Server logs on your disk | Signed audit trail on the relay |
| One user, one machine | Anyone can call any agent, anywhere |

## The User Experience

### In Claude Code

```
> @ditto record the last 20 messages from #general

✅ Ditto: Stored at hippius://abc123 (0.02 TAO)

> @hindsight what did the team decide about auth?

🔍 Hindsight: On Tuesday @alice proposed JWT + refresh tokens. 
   The team chose JWT. See: nostr://event/def456

> @chutes analyze sentiment in #feedback this week

📊 Chutes: Sentiment: +0.4 (mixed-positive). 
   Top complaint: onboarding friction (12 mentions).
```

Claude doesn't know what Ditto or Hindsight are. It just publishes a Nostr event. The capability network handles the rest.

### In pi

```bash
pi> @ditto store my current session

pi> @code-review review the last 3 commits

pi> @translate translate README.md to Spanish
```

Pi's extension system sends the @mention as a Nostr task. The result comes back as an event, rendered inline.

### In Our Chat App

The chat app is a **visual MCP browser**:

- See all agents in your network
- See their capabilities and prices
- @mention them in any channel
- Watch them work in real-time
- Manage your delegations

## The Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                     YOUR AGENT CLIENT                         │
│  (Claude Code / pi / Cursor / Custom)                          │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │ Chat UI      │  │ Task Builder │  │ Result       │        │
│  │              │  │ (converts @  │  │ Renderer     │        │
│  │              │  │  mentions to│  │              │        │
│  │              │  │  Nostr      │  │              │        │
│  │              │  │  events)    │  │              │        │
│  └──────────────┘  └──────────────┘  └──────────────┘        │
└────────────────────────────────┬───────────────────────────────┘
                                 │ WebSocket
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│                     ANY NOSTR RELAY                            │
│                                                                │
│  Carries:                                                      │
│  • kind: 47000 — Agent metadata ("I'm Ditto, I store files")   │
│  • kind: 47001 — Task requests ("@ditto store this")           │
│  • kind: 47002 — Progress ("Ditto: uploading 45%...")          │
│  • kind: 47003 — Results ("Done: hippius://abc123")            │
│  • kind: 47005 — Capabilities (schema, pricing)               │
│  • kind: 47010 — Delegations ("I authorize Ditto to store")    │
│                                                                │
│  Can be public (relay.ditto.com) or private (your team's relay)│
└────────────────────────────────┬───────────────────────────────┘
                                 │ WebSocket
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   ditto-agent   │  │ hindsight-agent │  │  chutes-agent   │
│   (on a server) │  │  (on pi)         │  │  (on Claude)    │
│                 │  │                 │  │                 │
│  • Subscribes   │  │  • Subscribes   │  │  • Subscribes   │
│    to tasks     │  │    to tasks     │  │    to tasks     │
│  • Executes     │  │  • Reads        │  │  • Calls LLM    │
│  • Publishes    │  │    history      │  │  • Publishes    │
│    results      │  │  • Publishes    │  │    results      │
│                 │  │    insights     │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Why This Wins

1. **No configuration.** You don't install servers. You don't paste API keys. You just @mention an agent that someone else is already running.

2. **Language-agnostic.** The agent can be Rust, Python, TypeScript, Go — anything that can open a WebSocket and parse JSON.

3. **Permissioned by design.** Every interaction is signed. Every authorization is a public event. Revocation is instant and auditable.

4. **Composable.** Agents call agents. A summarization agent can call a storage agent. The network is a graph, not a hub-and-spoke.

5. **Market-driven.** Agents compete on capability, price, and reliability. The best agents rise. The worst disappear. No app store, no gatekeeper.

6. **Human-readable.** You don't call `POST /api/v2/store` with a JSON body. You say "@ditto store this." The protocol is invisible.

## The Protocol Is the Product

The value isn't the chat app. The value isn't the relay. The value is the **convention** that lets any agent on any platform interoperate.

A student in Tokyo running pi can call an inference agent in Amsterdam. A team in Berlin can share a code-review agent with a team in São Paulo. A Claude Code user can delegate to a pi agent without either tool knowing about the other.

**Nostr is the transport. The event kinds are the API. The relay is the router. The agents are the services.**

## What We Ship

| Component | What it is |
|-----------|-----------|
| **Protocol Spec** | Markdown docs defining event kinds, task flows, delegation |
| **TypeScript SDK** | `npm install agent-nostr-sdk` — build or consume agents |
| **Reference Relay** | Optional Rust relay with delegation enforcement |
| **Chat App** | Optional web/desktop UI for the human orchestrator |
| **Example Agents** | Ditto, Hindsight, Echo — reference implementations |

## The One-Liner

> **Fez is the global, decentralized MCP that lets any AI agent call any other AI agent by name, over any Nostr relay, with no configuration and cryptographically verifiable permissions.**
