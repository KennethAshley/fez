# AGENTS.md — AI Agent Contributor Guide

This guide is for AI agents contributing to the Fez codebase.

## What Is This Project?

Fez is a protocol and reference implementation for **agent-centric communication on Nostr**. Every actor — human or AI — is a Nostr pubkey. Events are signed. The relay is (mostly) dumb.

**Fez is TypeScript end to end.** The SDK (`@fezchat/protocol`, a single npm package with a `fez` CLI) in `src/` is a single Node process — no database, no Docker — that connects to any Nostr relay and speaks the event-kind protocol below. There is no Rust component, planned or otherwise; an earlier plan for a Rust workspace (`crates/`, `Cargo.toml`) was scrapped and removed. If you see references to it in git history or older doc drafts, they're stale.

**Key difference from Buzz (the parent project):** Buzz is a team chat platform where humans are primary and agents are assistants. Fez strips the human chat layer and makes agents first-class peers.

## Heritage

This is a fork-concept from [Buzz](https://github.com/block/buzz) (Block, Inc.). Only the *protocol design* carries over — the Nostr event pipeline (verify → store → fan-out) and delegation-as-permission-primitive model. Buzz's own implementation (Rust workspace, Tauri desktop app, Postgres/Redis) is not part of Fez; Fez reimplements the relevant ideas in TypeScript.

We strip away from Buzz:
- Desktop app (Tauri + React)
- Mobile app (Flutter)
- Channels, reactions, presence, huddles
- Membership/role system
- The Rust/Postgres/Redis backend

## Current vs. Planned

| | Status | Where |
|---|---|---|
| TypeScript SDK (`Agent`, `CapabilityClient`, CLI) | **Working** | `src/` |
| Event kind protocol (47000–47099) | **Working**, matches spec | `src/kinds.ts`, `docs/protocol/kinds.md` |
| Local dev relay (in-memory, for testing) | **Working** | `dev/local-relay.ts` |
| Claude Code integration package | **Working** | `packages/claude-code/` |
| Delegation/budget enforcement, self-hosted relay | **Not built** — speced in `docs/protocol/`, nothing enforces it yet. If built, it'll be TypeScript. | — |

## Project Structure

```
fez/
├── src/                       # @fezchat/protocol — kinds registry, relay conn, DM crypto,
│                              #   harness/ACP driving, personas, extensions API, CLI
├── packages/
│   ├── fez-client/            # The headless brain: derived state + trust rules (TUI, desktop, extensions all share it)
│   ├── fez-relay/             # The relay: NIP-01 + search + policy hooks + --extensions loader
│   ├── fez-acp/               # Standing agent runtime (spawned by `fez agent` / the sentinel)
│   ├── fez-sentinel/          # Always-on watcher: summons (incl. thread-scoped), schedules, background tasks
│   ├── fez-desktop/           # Tauri app; GUI extension loader (gui-extensions.ts is the seam registry)
│   ├── fez-git/               # Git hosting (the reference multi-part extension — see its README)
│   ├── fez-github/ fez-docs/ fez-dms/ fez-media/ …   # more installable extensions
│   ├── fez-orchestrator/      # @fez routing agent
│   └── fez-evals/             # THE GATE: 700+ tests — run before claiming anything works
└── docs/                       # architecture, protocol specs
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

Any standard Nostr relay works — the SDK connects via plain WebSocket/NIP-01 (`src/relay.ts`, using `nostr-tools`' `SimplePool`). Delegation validation, budget tracking, and audit logging are meant to be optional relay-side additions, not requirements — no relay in this repo implements them yet, so nothing enforces them today.

**Practical note:** general-purpose public relays (e.g. `wss://relay.damus.io`, the default in several places) aren't guaranteed to handle unfamiliar custom kinds like `47000+` reliably — for local development, prefer `npx tsx dev/local-relay.ts` over a public relay. See `docs/decentralized-mcp.md` and the relay-inconsistency discussion this caused during development.

### The Agent Contract

Agent scripts are self-contained — they construct their own `Agent` and call `.start()`, they don't implement a subprocess/RPC contract:

```typescript
import { Agent } from "@fezchat/protocol";

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

### Extensions Are Multi-Part Packages

A feature ships as ONE package with several attachment points, declared
in `package.json` `fez.parts`: `relay` (loaded by `--extensions`),
`headless` (TUI/sentinel), `workspace` (checkout providers), `gui`
(desktop webview), plus npm `bin` (→ `~/.fez/bin`) and
`background: true` (sentinel runs its scheduled tasks). `fez install`
and `fez link` place all of them. Never bake a feature into core: core
grows *generic seams* (a register function, a permission), extensions
grow the feature. `packages/fez-git` is the worked example.

### Mirrors, and the Gate That Keeps Them Honest

Extensions carry hand-written `api-types.ts` / `gui-types.ts` mirrors of
the host APIs (type-only, so a bundle has zero imports).
`api-mirror-conformance.test.ts` compiles every mirror against the real
API — a mirror may omit members, never disagree. Runtime backends cast
into those types can still be NARROWER than the type (a missing method
throws at call time, invisibly): when a seam consumer can be hosted by
several backends, guard the method (`typeof x.f === "function"`) and
fail LOUD.

### Duplicated Surfaces Need Drift Gates

When one command deliberately exists on two surfaces (e.g. `/repo` in
headless and gui), add a parity test (`git-command-parity.test.ts`
pattern) — a verb added one-sided has already shipped a silent fall-through once.

### One Implementation for One Meaning

Semantics that two callers must agree on live in exactly one module both
import: merge rules (relay endpoint), journal format, ref policy,
persona invites, the repo-doc template. "Two implementations agreeing"
is a promise; one implementation is a fact.

## Quality Rules

- No `as any` to silence a type error you don't understand — that exact pattern (`filters as any` in `RelayConnection`) previously masked a real API mismatch with the installed `nostr-tools` version and caused silent wire-protocol corruption. If a type doesn't fit, that's usually a real signal.
- Typecheck before considering anything done: `npx tsc --noEmit`
- New public API (exported from `src/index.ts`) should have a doc comment, only where the *why* isn't obvious from the signature — not restating the type.
- No test suite exists yet despite `vitest` being a devDependency — there are no `*.test.ts` files. If you add non-trivial logic, consider adding one rather than assuming coverage exists.

## Adding a New Event Kind

1. Add the constant to `src/kinds.ts` (and export it from `AGENT_KINDS`)
2. Document it in `docs/protocol/kinds.md` — keep the two in sync, nothing enforces this automatically
3. If the SDK needs to construct/parse this kind's payload, add the type to the relevant file in `src/` (`agent.ts` for lifecycle events, `client.ts` for discovery/task-sending)

## Adding a New Agent

1. Write a `.ts` file that follows the contract above: `Agent.create()` → `agent.onTask()` → `agent.start()`, reading `FEZ_RELAY`/`FEZ_PRIVATE_KEY` from env
2. Test it locally against `dev/local-relay.ts` (see Testing below) before pointing it at a public relay
3. Add a README with task types, capabilities, and setup
4. Optionally: add adapter modules for external services (Hippius, Chutes, etc.) — see `examples/ditto-agent/README.md` for the intended shape (not yet implemented)

## Testing

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
- Read `docs/minimal-vs-application.md` for why the SDK is minimal and what an optional heavier layer would add
- Read `docs/protocol/delegation.md` for the trust model (spec only — not enforced in code yet)
- Read `examples/echo-agent.ts` for the simplest working agent
- Read `docs/architecture.md` for the current system diagram and trust model

## License

MIT (see `package.json`, `README.md`).
