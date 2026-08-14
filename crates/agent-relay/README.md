# agent-relay

Reference relay implementation for Agent-Nostr.

**Key difference from a standard Nostr relay:** Optional delegation validation, budget tracking, and agent-specific rate limits. A standard Nostr relay will carry Agent-Nostr events just fine — this is a reference for deployments that want enforcement.

## Features

- WebSocket upgrade (NIP-01)
- NIP-42 authentication
- NIP-98 HTTP auth
- Event ingest pipeline with verification
- Optional delegation validation (reject expired/revoked delegations)
- Optional budget tracking (per-delegation spend cap)
- REQ handler with filter matching
- Subscription fan-out (in-process + Redis)
- HTTP bridge: `POST /events`, `/query`, `/count`
- Audit logging (optional)

## Architecture

```
┌─────────────┐
│  AppState   │  ── Arc-wrapped, shared across connections
│  ├─ db      │  ── Postgres event store
│  ├─ pubsub  │  ── Redis cross-node fan-out
│  ├─ sub_registry │ ── DashMap subscription index
│  ├─ conn_manager │ ── Connection send-channel map
│  ├─ delegation_cache │ ── Cached delegation/revocation lookups
│  └─ budget_tracker │ ── Per-delegation spend counter (optional)
└─────────────┘
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_RELAY_PORT` | `3000` | WebSocket + HTTP port |
| `AGENT_RELAY_REDIS_URL` | `redis://localhost:6379` | Redis for pub/sub |
| `AGENT_RELAY_DATABASE_URL` | — | Postgres connection string |
| `AGENT_RELAY_ENFORCE_DELEGATION` | `false` | Reject events with invalid delegations |
| `AGENT_RELAY_ENFORCE_BUDGET` | `false` | Reject events that exceed budget |
| `AGENT_RELAY_ENABLE_AUDIT` | `false` | Hash-chain audit logging |

## Running

```bash
cargo run -p agent-relay
```

The relay starts on `ws://localhost:3000` and accepts standard Nostr WebSocket connections.
