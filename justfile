# Agent-Nostr — development task runner

set dotenv-load := true

default:
    @just --list

# ─── Dev Environment ─────────────────────────────────────────────────────────

# Start Docker services (Postgres, Redis), run migrations
setup:
    docker compose up -d
    cargo run -p agent-relay --bin migrate || true

# Stop Docker services
down:
    docker compose down

# ─── Build ───────────────────────────────────────────────────────────────────

# Build the Rust workspace
build:
    cargo build --workspace

# Build in release mode
build-release:
    cargo build --workspace --release

# ─── Check ───────────────────────────────────────────────────────────────────

# Run all checks
 check: fmt-check clippy

# Format check
fmt-check:
    cargo fmt --all -- --check

# Format
fmt:
    cargo fmt --all

# Clippy
clippy:
    cargo clippy --workspace --all-targets -- -D warnings

# ─── Test ────────────────────────────────────────────────────────────────────

# Run unit tests (no infra needed)
test-unit:
    cargo test --lib --workspace

# Run integration tests (needs Postgres + Redis)
test-integration:
    cargo test --workspace

# ─── Run ─────────────────────────────────────────────────────────────────────

# Start the reference relay
relay:
    cargo run -p agent-relay

# Run the echo agent (for testing)
echo-agent:
    cargo run -p agent-acp -- \
        --relay ws://localhost:3000 \
        --agent examples/echo-agent/echo_agent.py

# Run the ditto agent (real example)
ditto-agent:
    cargo run -p agent-acp -- \
        --relay ws://localhost:3000 \
        --agent examples/ditto-agent/ditto_agent.py \
        --max-agents 2

# ─── CLI ─────────────────────────────────────────────────────────────────────

# Generate a key
keygen:
    cargo run -p agent-cli -- keygen

# Inspect an agent
inspect pubkey:
    cargo run -p agent-cli -- inspect --pubkey {{pubkey}} --relay ws://localhost:3000

# Send a task
task agent type instruction:
    cargo run -p agent-cli -- task \
        --agent {{agent}} \
        --type {{type}} \
        --instruction "{{instruction}}" \
        --relay ws://localhost:3000

# Watch for results
watch:
    cargo run -p agent-cli -- watch --relay ws://localhost:3000
