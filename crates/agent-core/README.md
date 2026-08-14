# agent-core

Zero-I/O foundation for Agent-Nostr. Types, event kinds, signature verification, and filter matching.

**Key rule:** This crate has no async runtime, no network, no database. It is pure logic that every other crate builds on.

## Contents

- `src/kind.rs` — Event kind constants (47000–47099) and `ALL_KINDS` registry
- `src/verification.rs` — `verify_event()` (Schnorr + SHA-256, CPU-bound)
- `src/filters.rs` — `filters_match()` (NIP-01 filter matching)
- `src/events.rs` — `StoredEvent`, `AgentEvent` wrappers
- `src/security.rs` — `is_private_ip()` and other SSRF utilities

## Usage

```rust
use agent_core::{verify_event, filters_match, KIND_AGENT_TASK};

// Verify a signed event
let valid = verify_event(&event)?;

// Check if event matches subscription filters
let matched = filters_match(&filters, &event);
```

## No External I/O Dependencies

`Cargo.toml` explicitly prohibits:
- `tokio`
- `sqlx`
- `redis`
- `axum`

This ensures the crate stays pure and fast to compile.
