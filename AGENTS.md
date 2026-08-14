# AGENTS.md — AI Agent Contributor Guide

This guide is for AI agents contributing to the Fez codebase.

## What Is This Project?

Fez is a protocol and reference implementation for **agent-centric communication on Nostr**. Every actor — human or AI — is a Nostr pubkey. Events are signed. The relay is (mostly) dumb.

**The working implementation is the TypeScript SDK in `src/`** (`@fez/protocol`, published as a single npm package with a `fez` CLI). It's a single Node process — no database, no Docker — that connects to any Nostr relay and speaks the event-kind protocol below. See `docs/minimal-vs-application.md` for the full rationale.

The `crates/` directory is a **planned, not-yet-implemented** Rust workspace for an optional heavier layer (self-hosted relay with delegation enforcement, ACP-style subprocess agent harness). Right now each crate is a stub `README.md` with no source — `cargo build` will not produce anything. Don't assume Rust code exists just because `Cargo.toml` lists a crate; check for `.rs` files first.

**Key difference from Buzz (the parent project):** Buzz is a team chat platform where humans are primary and agents are assistants. Fez strips the human chat layer and makes agents first-class peers.

## Heritage

This is a fork-concept from [Buzz](https://github.com/block/buzz) (Block, Inc.). The *protocol design* (Nostr event pipeline: verify → store → fan-out, delegation-as-permission-primitive) inherits from Buzz's model. `docs/architecture.md` documents both what actually runs today (the TS SDK) and, clearly separated at the bottom, the originally-planned Rust workspace/ACP subprocess harness that isn't built yet.

We strip away from Buzz:
- Desktop app (Tauri + React)
- Mobile app (Flutter)
- Channels, reactions, presence, huddles
- Membership/role system

## Current vs. Planned

| | Status | Where |
|---|---|---|
| TypeScript SDK (`Agent`, `CapabilityClient`, CLI) | **Working** | `src/` |
| Event kind protocol (47000–47099) | **Working**, matches spec | `src/kinds.ts`, `docs/protocol/kinds.md` |
| Local dev relay (in-memory, for testing) | **Working** | `dev/local-relay.ts` |
| Claude Code integration package | **Working** | `packages/claude-code/` |
| Rust reference relay / ACP harness / orchestrator CLI | **Not implemented** — README stubs only | `crates/*` |
| `docs/architecture.md` | **Reconciled** — describes the current TS architecture, with the unbuilt Rust/ACP path clearly separated at the bottom | `docs/architecture.md` |
| `justfile` | **Rust-only** (`cargo run -p ...`) — none of these targets currently work since the crates have no source | `justfile` |

If you're asked to "wire up the relay" or "run the agent harness," clarify whether that means the working TS path (`dev/local-relay.ts` + `src/agent.ts`) or the planned Rust path (`crates/agent-relay`, `crates/agent-acp`) — they are not interchangeable and only one exists today.

## Project Structure

```
fez/
├── Cargo.toml               # Rust workspace (crates are stubs, see table above)
├── package.json              # @fez/protocol — the real, working package
├── tsconfig.json
├── justfile                  # Rust task runner — currently non-functional (no crate source)
├── src/                       # The TypeScript SDK — start here
│   ├── kinds.ts               # Event kind constants (47000-47099)
│   ├── agent.ts               # Agent class — connects, publishes metadata, handles tasks
│   ├── client.ts              # CapabilityClient — discover agents, send tasks
│   ├── relay.ts                # RelayConnection — thin wrapper over nostr-tools SimplePool
│   ├── tui.ts                  # Interactive chat REPL (`fez` with no args)
│   ├── package-manager.ts      # `fez install/list/remove` — installs agent/integration packages
│   └── cli.ts                  # Commander-based CLI entrypoint
├── dev/
│   └── local-relay.ts          # Minimal in-memory Nostr relay for local testing
├── docs/
│   ├── architecture.md         # Current TS architecture + planned Rust layer at the bottom
│   ├── minimal-vs-application.md  # Why the SDK is TS-first; Rust layer is optional/future
│   ├── orchestrator.md          # The two Fez interfaces (TUI + CLI) sharing one protocol
│   ├── tui-design.md            # `fez` chat REPL design
│   └── protocol/
│       ├── kinds.md              # Event kind registry (47000–47099) — matches src/kinds.ts
│       ├── tasking.md            # Task request/progress/result flow
│       ├── delegation.md         # Human-to-agent authority delegation
│       ├── discovery.md          # Agent discovery and capability advertisement
│       └── payments.md           # Budgets and payment flows (v2)
├── crates/                    # Rust workspace — stub READMEs only, no source yet
│   ├── agent-core/
│   ├── agent-relay/
│   ├── agent-acp/
│   ├── agent-cli/
│   └── agent-dev-mcp/
├── packages/
│   └── claude-code/            # @fez/claude-code — Claude Code integration
└── examples/
    ├── echo-agent.ts            # The actual working minimal agent — run this, not examples/echo-agent/
    ├── echo-agent/README.md     # Vestigial: describes an unbuilt Python/ACP version, no code
    └── ditto-agent/README.md    # Real-world example writeup (Hippius + Chutes), no code yet
```

## Key Patterns

### Event Kinds Are the Only Switch

Every action is a Nostr event kind (defined in both `src/kinds.ts` and `docs/protocol/kinds.md` — keep them in sync):
- `47000` = agent metadata
- `47001` = task request
- `47002` = progress update
- `47003` = result
- `47010` = delegation
- `47011` = revocation
- `47012` = cancel

New feature? New kind number. No breaking changes.

### Delegation Is the Permission Primitive

No roles. No channels. No membership lists. Just:
1. Human signs a `KIND_AGENT_DELEGATION` event
2. Agent references it in task events
3. Anyone can verify by querying the relay

(Delegation is speced in `docs/protocol/delegation.md` but not yet enforced anywhere in `src/` — the TS SDK doesn't currently check delegation events before executing a task. Treat this as unimplemented, not as a broken feature.)

### Relay Is Optional Enforcement

Any standard Nostr relay works — the SDK connects via plain WebSocket/NIP-01 (`src/relay.ts`, using `nostr-tools`' `SimplePool`). Delegation validation, budget tracking, and audit logging are meant to be optional relay-side additions (the planned `agent-relay` Rust crate), not requirements — they don't exist yet, so nothing enforces them today.

**Practical note:** general-purpose public relays (e.g. `wss://relay.damus.io`, the default in several places) aren't guaranteed to handle unfamiliar custom kinds like `47000+` reliably — for local development, prefer `npx tsx dev/local-relay.ts` over a public relay. See `docs/decentralized-mcp.md` and the relay-inconsistency discussion this caused during development.

### The Agent Contract (TypeScript)

Agent scripts are self-contained — they construct their own `Agent` and call `.start()`, they don't implement a subprocess/RPC contract:

```typescript
import { Agent } from "@fez/protocol";

const agent = await Agent.create({
  relay: process.env.FEZ_RELAY || "wss://relay.damus.io",
  name: "my-agent",
  supportedTasks: ["my-task"],
  privateKey: process.env.FEZ_PRIVATE_KEY, // auto-generates if unset
});

agent.onTask(async (task) => {
  await task.reply({ status: "success", result: { ... } });
});

await agent.start();
```

Reading `FEZ_RELAY`/`FEZ_PRIVATE_KEY` from the environment (rather than hardcoding) is the convention that lets `fez run <file> -r <url> -k <keyfile>` pass CLI flags through to a self-contained script — see `examples/echo-agent.ts`. `fez run` does **not** inject an `Agent` instance into the script; it does not expect a default export.

## Quality Rules

**TypeScript (`src/`, `dev/`, `examples/`, `packages/`) — where all current work happens:**
- No `as any` to silence a type error you don't understand — that exact pattern (`filters as any` in `RelayConnection`) previously masked a real API mismatch with the installed `nostr-tools` version and caused silent wire-protocol corruption. If a type doesn't fit, that's usually a real signal.
- Typecheck before considering anything done: `npx tsc --noEmit`
- New public API (exported from `src/index.ts`) should have a doc comment, only where the *why* isn't obvious from the signature — not restating the type.
- No test suite exists yet despite `vitest` being a devDependency — there are no `*.test.ts` files. If you add non-trivial logic, consider adding one rather than assuming coverage exists.

**Rust (`crates/`) — only relevant once actual source exists:**
- No `unsafe` code
- No new `unwrap()` in production paths — use `?`
- `just check` (fmt + clippy) — not runnable today, no crate source to check

## Adding a New Event Kind

1. Add the constant to `src/kinds.ts` (and export it from `AGENT_KINDS`)
2. Document it in `docs/protocol/kinds.md` — keep the two in sync, nothing enforces this automatically
3. If the SDK needs to construct/parse this kind's payload, add the type to the relevant file in `src/` (`agent.ts` for lifecycle events, `client.ts` for discovery/task-sending)
4. (Only if `crates/agent-core` has actual source by the time you read this) mirror the constant there too

## Adding a New Agent

1. Write a `.ts` file that follows the contract above: `Agent.create()` → `agent.onTask()` → `agent.start()`, reading `FEZ_RELAY`/`FEZ_PRIVATE_KEY` from env
2. Test it locally against `dev/local-relay.ts` (see Testing below) before pointing it at a public relay
3. Add a README with task types, capabilities, and setup
4. Optionally: add adapter modules for external services (Hippius, Chutes, etc.) — see `examples/ditto-agent/README.md` for the intended shape (not yet implemented)

## Testing

There's no `just` target that currently works (`crates/` has no source to build/run). Use the TS CLI directly:

```bash
npx tsc --noEmit                                              # typecheck
npx tsx dev/local-relay.ts 7777                                # terminal 1: local relay
npx tsx src/cli.ts run examples/echo-agent.ts -r ws://localhost:7777   # terminal 2: echo agent
npx tsx src/cli.ts discover -r ws://localhost:7777              # terminal 3: verify discovery
npx tsx src/cli.ts send -r ws://localhost:7777 -t <pubkey> --type echo -i "hello"  # send a task
```

Prefer `dev/local-relay.ts` over a public relay for iteration — it's instant and deterministic, and avoids the "does this relay even store kind 47000" uncertainty described above.

## When In Doubt

- Read `docs/protocol/kinds.md` for event semantics
- Read `docs/minimal-vs-application.md` for why the SDK is TS-first and what the (currently unbuilt) Rust layer is for
- Read `docs/protocol/delegation.md` for the trust model (spec only — not enforced in code yet)
- Read `examples/echo-agent.ts` for the simplest working agent — not `examples/echo-agent/README.md`, which describes an unbuilt Python/ACP version
- Read `docs/architecture.md` for the current system diagram and trust model — the Rust layer described at its bottom is planned, not built

## License

**Inconsistent in the repo as of this writing** — `package.json` and `README.md` say MIT; `Cargo.toml` and the previous version of this file said Apache-2.0. This needs a decision from the project owner, not a silent pick by whoever edits this file next. Don't assume either until it's resolved.
