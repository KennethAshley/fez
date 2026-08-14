# AGENTS.md — AI Agent Contributor Guide

This guide is for AI agents contributing to the Agent-Nostr codebase.

## What Is This Project?

Agent-Nostr is a protocol and reference implementation for **agent-centric communication on Nostr**. Every actor — human or AI — is a Nostr pubkey. Events are signed. The relay is (mostly) dumb.

**Key difference from Buzz (the parent project):** Buzz is a team chat platform where humans are primary and agents are assistants. Agent-Nostr strips the human chat layer and makes agents first-class peers.

## Heritage

This is a fork-concept from [Buzz](https://github.com/block/buzz) (Block, Inc.). We inherit:
- Rust workspace structure
- ACP harness pattern (stdio JSON-RPC agent spawning)
- Nostr event pipeline (verify → store → fan-out)
- Postgres + Redis infrastructure

We strip away:
- Desktop app (Tauri + React)
- Mobile app (Flutter)
- Channels, reactions, presence, huddles
- Membership/role system

## Project Structure

```
agent-nostr/
├── Cargo.toml              # Rust workspace
├── justfile                # Task runner
├── docs/
│   ├── architecture.md     # System design
│   └── protocol/
│       ├── kinds.md        # Event kind registry (47000–47099)
│       ├── tasking.md      # Task request/progress/result flow
│       ├── delegation.md   # Human-to-agent authority delegation
│       ├── discovery.md    # Agent discovery and capability advertisement
│       └── payments.md     # Budgets and payment flows (v2)
├── crates/
│   ├── agent-core/         # Zero-I/O: kinds, verification, filters
│   ├── agent-relay/        # Reference relay (optional delegation enforcement)
│   ├── agent-acp/          # Agent harness (ACP JSON-RPC over stdio)
│   ├── agent-cli/          # Orchestrator CLI (human interface)
│   └── agent-dev-mcp/      # MCP server bridge (Claude Desktop, Cursor)
└── examples/
    ├── echo-agent/         # Minimal agent template
    └── ditto-agent/        # Real example (Hippius + Chutes)
```

## Key Patterns

### Event Kinds Are the Only Switch

Every action is a Nostr event kind:
- `47001` = task request
- `47002` = progress update
- `47003` = result
- `47010` = delegation
- `47011` = revocation

New feature? New kind number. No breaking changes.

### Delegation Is the Permission Primitive

No roles. No channels. No membership lists. Just:
1. Human signs a `KIND_AGENT_DELEGATION` event
2. Agent references it in task events
3. Anyone can verify by querying the relay

### Relay Is Optional Enforcement

A standard Nostr relay works fine. `agent-relay` adds optional:
- Delegation validation
- Budget tracking
- Audit logging

But the protocol doesn't require these. The agent harness should also verify independently.

### ACP Subprocess Contract

Agents are subprocesses that speak JSON-RPC over stdio:
- Input: `session/prompt` requests
- Output: `session/post_output` or `tools/call` requests
- The harness handles all Nostr networking

## Quality Rules

- No `unsafe` code
- No new `unwrap()` in production paths — use `?`
- New public API must have doc comments
- Pre-commit: `just check` (fmt + clippy)
- Before PR: `just test-unit` (no infra) or `just test-integration` (needs Docker)

## Adding a New Event Kind

1. Add constant to `crates/agent-core/src/kind.rs`
2. Add payload type to `crates/agent-core/src/events.rs` if structured
3. Handle in `agent-relay/src/handlers/event.rs` if relay needs special behavior
4. Document in `docs/protocol/kinds.md`
5. Add test in `crates/agent-core/src/kind.rs` tests

## Adding a New Agent

1. Create directory under `examples/`
2. Implement ACP JSON-RPC contract (see `examples/echo-agent/`)
3. Add README with task types, capabilities, and setup
4. Optionally: add adapter modules for external services (Hippius, Chutes, etc.)

## Testing

```bash
just test-unit        # unit tests, no infra
just relay            # start relay in one terminal
just echo-agent       # run test agent in another
just task <pubkey> echo "Hello"  # send task via CLI
just watch            # watch for results
```

## When In Doubt

- Read `docs/protocol/kinds.md` for event semantics
- Read `docs/architecture.md` for system design
- Read `docs/protocol/delegation.md` for trust model
- Read `examples/echo-agent/` for the simplest working agent

## License

Apache-2.0
