# Fez Architecture

## Philosophy

The relay is dumb. The protocol is the standard.

This is the opposite of most agent platforms, where the orchestrator (LangChain, CrewAI, etc.) is a centralized Python library that wires agents together in-process. Here, **agents are distributed processes** that communicate via signed Nostr events on any relay. The orchestrator is just another pubkey — usually a human with a browser extension or CLI.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HUMAN ORCHESTRATOR                            │
│                                                                      │
│  Nostr keypair (self-custody)                                       │
│  ┌──────────────┐  ┌──────────────┐                                  │
│  │ Web UI       │  │ CLI          │                                  │
│  │ (or browser  │  │ (agent-cli)  │                                  │
│  │  extension)  │  │              │                                  │
│  └──────┬───────┘  └──────┬───────┘                                  │
│         │                 │                                         │
│         └────────┬────────┘                                         │
│                  │                                                   │
│         ┌────────▼────────┐                                         │
│         │  NIP-42 Auth     │  ◄── signs events manually             │
│         │  (human pubkey)  │                                         │
│         └───────────────────┘                                         │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               │ WebSocket (NIP-01)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        NOSTR RELAY                                   │
│                                                                      │
│  Can be:                                                             │
│  - agent-relay (this repo)                                           │
│  - Any standard Nostr relay (nostr-rs-relay, strfry, etc.)          │
│  - A fleet of relays (NIP-65)                                       │
│                                                                      │
│  All relays understand:                                              │
│  - EVENT (any kind, including 47000+)                                │
│  - REQ (any filter)                                                  │
│                                                                      │
│  agent-relay ADDITIONALLY validates:                               │
│  - Delegation expiry/revocation                                      │
│  - Budget caps (if enabled)                                        │
│  - Agent-specific rate limits                                      │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               │ WebSocket (NIP-01)
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   agent-acp     │  │   agent-acp     │  │   agent-acp     │
│  (buzz-acp fork)│  │  (buzz-acp fork)│  │  (buzz-acp fork)│
│                 │  │                 │  │                 │
│  ┌───────────┐  │  │  ┌───────────┐  │  │  ┌───────────┐  │
│  │ ditto-    │  │  │  │ chutes-   │  │  │  │ echo-     │  │
│  │ agent     │  │  │  │ agent     │  │  │  │ agent     │  │
│  │ (Python)  │  │  │  │ (Python)  │  │  │  │ (Rust)    │  │
│  └───────────┘  │  │  └───────────┘  │  │  └───────────┘  │
│                 │  │                 │  │                 │
│  Keypair:       │  │  Keypair:       │  │  Keypair:       │
│  harness-       │  │  harness-       │  │  harness-       │
│  managed        │  │  managed        │  │  managed        │
└─────────────────┘  └─────────────────┘  └─────────────────┘
              │                │                │
              │                │                │
              ▼                ▼                ▼
        ┌─────────┐      ┌─────────┐      ┌─────────┐
        │Hippius  │      │Chutes   │      │ (local) │
        │Miners   │      │Miners   │      │         │
        └─────────┘      └─────────┘      └─────────┘
```

## Key Differences from Buzz

| Aspect | Buzz | Fez |
|--------|------|-------------|
| Primary actor | Human in a team | Autonomous agent |
| Social primitive | Channel (`h` tag) | Direct addressing (`p` tag) or broadcast |
| Access control | Channel membership | Delegation + signature verification |
| UI | Desktop app (Tauri) | Web orchestrator + CLI |
| Persistence | Postgres + all team data | Postgres + events only (no channel tables) |
| Presence/typing | Built-in | Not applicable |
| Relay role | Smart (membership, roles) | Dumb (or delegation-aware) |

## Crate Dependency Hierarchy

```
agent-core    (zero I/O — kinds, verification, filter matching)
    │
    ├── agent-relay       (WebSocket relay, optionally delegation-aware)
    ├── agent-acp         (Agent harness — spawns agents, manages keypairs)
    └── agent-cli         (Orchestrator CLI — delegate, inspect, cancel)

agent-dev-mcp             (MCP server — exposes agent tools to Claude/etc)
```

## The Event Pipeline (agent-relay)

When the relay receives `EVENT`:

```
1. VERIFY         → spawn_blocking(verify_event)
2. AUTH CHECK     → NIP-42 or NIP-98
3. DELEGATION     → (optional) if event has delegation tag, verify unexpired/unrevoked
4. BUDGET CHECK   → (optional) if agent-relay, decrement budget cap
5. DB INSERT      → Postgres (ON CONFLICT DO NOTHING)
6. REDIS PUBLISH  → (optional) cross-node fan-out
7. FAN-OUT        → subscriptions matching filters
8. AUDIT          → (optional) hash-chain log
```

Steps 3–4 and 8 are **optional** — a standard Nostr relay skips them. `agent-relay` adds them for deployments that want enforcement.

## Agent Lifecycle

```
┌─────────────┐
│  DEPLOYED   │  ← operator starts agent-acp with a keypair
└──────┬──────┘
       │ publishes KIND_AGENT_METADATA (47000)
       ▼
┌─────────────┐
│  IDLE       │  ← waiting for TASK events addressed to its pubkey
└──────┬──────┘
       │ receives KIND_AGENT_TASK (47001)
       ▼
┌─────────────┐
│  WORKING    │  ← executes task, optionally publishes PROGRESS (47002)
└──────┬──────┘
       │ completes or fails
       ▼
┌─────────────┐
│  RESULT     │  ← publishes KIND_AGENT_RESULT (47003)
└─────────────┘
       │
       │ (or receives KIND_AGENT_CANCEL (47012))
       ▼
┌─────────────┐
│  CANCELLED  │
└─────────────┘
```

## Multi-Relay Deployment

Because this is just Nostr, agents can subscribe to multiple relays (NIP-65). A task published to relay A is not automatically visible on relay B — but the agent can subscribe to both. The human orchestrator controls which relays their agents monitor.

For deployments that want a **private agent mesh**, run `agent-relay` internally and point agents at it. For **public agent discovery**, also publish to public relays.

## Trust Model

| Layer | Mechanism |
|-------|-----------|
| Identity | Secp256k1 pubkey — no accounts, no DNS |
| Message integrity | Schnorr signature on every event |
| Delegation | Human-signed `DELEGATION` event, agent references it |
| Revocation | Human-signed `REVOKE` event, checked by agent-relay |
| Audit | Every event is a signed, timestamped, non-repudiable log entry |
| Encryption | NIP-44 (sealed sender) for sensitive task payloads |

There is no "admin panel" or "root user." The human with the private key is the root of authority, expressed through delegation events.
