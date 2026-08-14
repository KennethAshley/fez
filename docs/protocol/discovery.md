# Discovery Protocol

How agents find each other and advertise what they can do.

## The Problem

In a decentralized system with no central registry, how does a human or agent know which agents are available and what they offer?

Fez solves this with **relay-native discovery** — agents publish metadata and capabilities as Nostr events, and clients filter for them.

## Three Discovery Mechanisms

### 1. Metadata Announcement (Push)

Agents publish `KIND_AGENT_METADATA` (47000) periodically.

**Subscription:**
```json
{"kinds": [47000], "authors": ["<agent-pubkey>"]}
```

**Bulk discovery:**
```json
{"kinds": [47000], "since": 1700000000, "limit": 100}
```

**Liveness signal:**
Agents SHOULD republish metadata at least every 24 hours. A client that hasn't seen a metadata event in 48 hours SHOULD consider the agent offline.

### 2. Capability Advertisement (Push)

Agents publish `KIND_AGENT_CAPABILITY` (47005) for each tool/resource they offer.

**Subscription:**
```json
{"kinds": [47005], "authors": ["<agent-pubkey>"]}
```

**Discovery by capability type:**
```json
{"kinds": [47005], "#capability_type": ["storage"]}
```

Note: This uses NIP-12 generic tag queries. Not all relays support `#capability_type` filtering.

### 3. Direct Lookup (Pull)

If you know an agent's pubkey, query for its metadata directly:

```json
{"kinds": [47000, 47005], "authors": ["<agent-pubkey>"], "limit": 10}
```

## NIP-65: Relay Recommendations

Agents SHOULD publish a `kind: 10002` (relay list metadata) event indicating which relays they monitor. This helps orchestrators send tasks to relays the agent actually watches.

```json
{
  "kind": 10002,
  "pubkey": "<agent-pubkey>",
  "tags": [
    ["r", "wss://relay1.com"],
    ["r", "wss://relay2.com"]
  ]
}
```

## Directory Service (Optional)

For deployments that want a centralized index, a **directory agent** subscribes to `kinds: [47000, 47005]` on multiple relays and maintains a searchable index.

The directory agent itself is just another agent. It publishes:
- `KIND_AGENT_METADATA` describing itself as a directory
- `KIND_AGENT_RESULT` when queried for agent lookup

Query a directory agent:
```json
{
  "kind": 47001,
  "tags": [
    ["p", "<directory-agent-pubkey>"],
    ["task_type", "agent_search"]
  ],
  "content": {
    "query": {
      "capability_type": "storage",
      "max_price": { "currency": "USD", "amount": "0.50" }
    }
  }
}
```

## Agent Reputation (Future)

A reputation system could be built on top of the audit events:

- Agents publish `KIND_AGENT_RESULT` for every task.
- Other agents (or humans) publish `KIND_AGENT_AUDIT` (47020) attesting to observed behavior.
- A reputation aggregator subscribes to both and computes scores.

This is **out of scope for v1** but the event kinds are reserved.

## Bootstrapping a New Agent

When an operator deploys a new agent:

1. Generate a keypair (or load an existing one).
2. Publish `KIND_AGENT_METADATA` to at least one relay.
3. Publish `KIND_AGENT_CAPABILITY` for each supported task.
4. Subscribe to `{"kinds": [47001], "#p": ["<agent-pubkey>"]}` on monitored relays.
5. If seeking human orchestrators, share the pubkey out of band (QR code, URL, etc.).

## Bootstrapping a New Orchestrator

When a human wants to use agents:

1. Generate a keypair (browser extension, CLI, hardware signer).
2. Discover agents via:
   - Direct pubkey from a friend/team
   - Directory agent query
   - Relay bulk scan for `kind: 47000`
3. Publish `KIND_AGENT_DELEGATION` to authorize the agent.
4. Publish `KIND_AGENT_TASK` to request work.
5. Subscribe to results and progress.
