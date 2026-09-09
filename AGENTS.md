# AGENTS.md — AI Agent Contributor Guide

This guide is for AI agents contributing to the Fez codebase.

## What Is This Project?

Fez is a protocol and reference implementation for **agent-centric communication on Nostr**. Every actor — human or AI — is a Nostr pubkey. Events are signed. The relay is (mostly) dumb.

**Fez is TypeScript, with one Rust exception.** The core (`@fezchat/protocol`, a single npm package with a `fez` CLI) in `src/` is a single Node process — no database, no Docker — that connects to any Nostr relay and speaks the event-kind protocol below. The exception: the desktop app's Tauri shell (`packages/fez-desktop/src-tauri/src/lib.rs`) is Rust and is the **key-custody boundary** (the identity key never enters the webview; the bridge exposes sign/encrypt/decrypt only) plus the no-npm extension installer and the bundled-agent/local-relay bootstrap. Everything protocol-shaped stays TypeScript.

**Key difference from Buzz (the parent project):** Buzz is a team chat platform where humans are primary and agents are assistants. Fez strips the human chat layer and makes agents first-class peers.

## Heritage

This is a fork-concept from [Buzz](https://github.com/block/buzz) (Block, Inc.). Only the *protocol design* carries over — the Nostr event pipeline (verify → store → fan-out) and delegation-as-permission-primitive model. Buzz's own implementation (Rust workspace, Tauri desktop app, Postgres/Redis) is not part of Fez; Fez reimplements the relevant ideas in TypeScript.

We strip away from Buzz:
- Desktop app (Tauri + React)
- Mobile app (Flutter)
- Channels, reactions, presence, huddles
- Membership/role system
- The Rust/Postgres/Redis backend

## Current state

| | Status | Where |
|---|---|---|
| Protocol core + CLI/TUI | **Working** | `src/` (`protocol/`, `agent/`, `identity/`, `extensions/`, `cli/`, `shared/`) |
| Event kind registry (30+ kinds: 47xxx agents/workspace, 40xxx apps/docs, 200xx ephemeral) | **Working** | `src/protocol/kinds.ts` (mirrored as `K` in `packages/fez-client`, drift-gated by `kinds-registry.test.ts`) |
| Self-hosted relay (policies, NIP-11/42/50, JSONL/SQLite) | **Working, deployed** at `wss://relay.fez.chat` | `packages/fez-relay`, `deploy/` |
| Headless client brain | **Working** | `packages/fez-client` |
| Standing agent runtime + sentinel + orchestrator | **Working** | `packages/fez-acp`, `fez-sentinel`, `fez-orchestrator` |
| Desktop app (signed, auto-updating, key custody in Rust) | **Working** | `packages/fez-desktop` |
| Delegation events (47010/47011) | **Speced only** — zero call sites; the enforced model is the workspace roster (47102) + owner attestation (47006) | `docs/archive/protocol/` (archived spec) |

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

Every action is a Nostr event kind, defined in `src/protocol/kinds.ts` — the registry is the spec, with the rationale in doc comments. The families:
- `47000`–`47030` = agents: metadata, attestation (47006), turn metrics (47030); the 47001–47003 task loop is the legacy SDK path
- `47101`–`47103` = workspace: channel, roster, channel message (+ `30047` bans)
- `40003`–`40300` = apps: edits, pins, scheduled sends, docs (40100), tool marketplace (40200/40201), artifacts (40300)
- `200xx` = ephemeral (never stored): presence, typing, streaming drafts (20003), observer stream (20004), owner cancel (20005)
- Standard nostr reused: 0, 5, 7, 14/1059 (NIP-17 DMs), 30078, 30174 (engrams), 1984

New feature? New kind number. No breaking changes. (The registry file `src/protocol/kinds.ts` is authoritative; the old `docs/archive/protocol/kinds.md` is archived design history.)

### The Roster Is the Permission Primitive

The workspace owner — the key named in the relay's NIP-11 `pubkey` — signs one roster (47102, roles `owner|admin|member|bot`) and one ban list (30047). Membership is workspace-wide; a banned key is a non-member everywhere. Agents gate authors additionally by `respondTo` policy, and "my agents may summon each other, strangers may not" works via owner **attestation** (47006). Delegation events (47010/47011) are speced in `docs/archive/protocol/delegation.md` but have zero call sites — treat as unimplemented.

### Relay Is Optional Enforcement

Any standard Nostr relay works — clients enforce everything from signed events. `packages/fez-relay` adds *optional* operator policies (membership at ingest, NIP-42-gated reads, moderation masking, rate limits) without making the store smart. The default relay is `wss://relay.fez.chat` (`DEFAULT_RELAY` in `src/shared/settings.ts`); for local development run `npm run dev:relay` (port 7777). A few legacy defaults still point at `wss://relay.damus.io` (`fez discover`, `fez send`, `examples/echo-agent.ts`) — public relays aren't guaranteed to store unfamiliar 47xxx kinds.

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
- The test suite is `packages/fez-evals` (69 test files, 700+ cases) — the only meaning of "it works" in this repo. New behavior needs a test there; run `npm run evals` (or `cd packages/fez-evals && npx vitest --run`) before claiming anything works.

## Adding a New Event Kind

1. Add the constant to `src/protocol/kinds.ts` with a doc comment explaining the *why* — the registry is the spec
2. Mirror it in the `K` table in `packages/fez-client/src/index.ts` — `kinds-registry.test.ts` fails on drift
3. If clients construct/parse the payload, the logic lives in `packages/fez-client` (one implementation for one meaning)

## Adding a New Agent

1. Write a `.ts` file that follows the contract above: `Agent.create()` → `agent.onTask()` → `agent.start()`, reading `FEZ_RELAY`/`FEZ_PRIVATE_KEY` from env
2. Test it locally against `dev/local-relay.ts` (see Testing below) before pointing it at a public relay
3. Add a README with task types, capabilities, and setup
4. Optionally: add adapter modules for external services (Hippius, Chutes, etc.) — see `examples/ditto-agent/README.md` for the intended shape (not yet implemented)

## Testing

```bash
npm run build                                 # scripts/build-all.mjs — core + every package
npm run evals                                 # THE GATE: packages/fez-evals, 700+ cases
npx tsc --noEmit                              # quick typecheck
npm run dev:relay                             # local relay on 7777 for manual iteration
```

For quick manual loops the legacy SDK path still works (`npx tsx dev/local-relay.ts 7777`, then `fez run examples/echo-agent.ts -r ws://localhost:7777`), but the evals are what "working" means.

## When In Doubt

- Read `src/protocol/kinds.ts` for event semantics (the registry is the doc)
- Read `docs/archive/minimal-vs-application.md` for the historical minimal-SDK rationale (archived)
- Read `docs/archive/protocol/delegation.md` for the old delegation spec (archived; the enforced trust model is roster + attestation, see src/identity/author-gate.ts)
- Read `examples/echo-agent.ts` for the simplest working agent
- Read `docs/architecture.md` for the current system diagram and trust model

## License

MIT (see `package.json`, `README.md`).
