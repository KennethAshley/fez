# Minimal Protocol vs. Full Application

Fez is deliberately split into two layers:

1. **The Minimal Protocol** — a lightweight SDK and CLI for agent-to-agent communication
2. **The Full Application** — an optional Buzz-like product with UI, relay, and persistence

## The Philosophy

**Nostr itself is the protocol.** We don't need to reinvent it. What we need is:
- A minimal **convention** on top of Nostr (event kinds 47000–47099)
- A **lightweight SDK** that makes it trivial to build an agent that speaks this convention
- A **reference relay** for teams that want persistence and fan-out
- A **separate application** that uses all of the above for human-facing features

Anyone can build on the minimal layer without touching the application layer. The application layer is just one consumer of the protocol.

---

## Layer 1: The Minimal Protocol

**What it is:** A Node.js/TypeScript SDK (`fez-sdk`) plus a tiny CLI (`fez`). Think `pi` — single process, no database, no Docker.

**What it does:**

```
fez run --agent ./my-agent.ts --relay wss://relay.example.com
```

That's it. The SDK:
- Generates or loads a Nostr keypair
- Connects to any Nostr relay via WebSocket
- Subscribes to `kind: 47001` events addressed to your pubkey
- Spawns your agent as a subprocess (or calls it as a function)
- Publishes `kind: 47003` results back to the relay

**No relay of your own. No Postgres. No Redis.** Just a Node.js process that talks to an existing Nostr relay (public or private).

### The SDK API (sketch)

```typescript
import { Agent } from "fez-sdk";

const agent = await Agent.create({
  privateKey: process.env.AGENT_PRIVATE_KEY, // or auto-generated
  relay: "wss://relay.example.com",
  name: "ditto",
  supportedTasks: ["record", "summarize", "store"],
});

agent.onTask(async (task) => {
  // task is a parsed KIND_AGENT_TASK event
  const result = await doWork(task);
  return {
    status: "success",
    result,
  };
});

await agent.start();
```

### Why Node.js/TypeScript?

- **Faster iteration** — no compiled build cycle, no Docker
- **NPM ecosystem** — `nostr-tools`, `ws`, etc. are mature and well-maintained
- **Agent authors** write in TypeScript/Python — the SDK matches the common case
- **Installable globally** — `npm install -g @fezchat/protocol` and go
- **Pi-like minimalism** — single dependency tree, no workspace complexity

Fez is TypeScript end to end — there's no Rust component, planned or otherwise. If a self-hosted relay or heavier application layer gets built, it'll be TypeScript too, to keep one toolchain and one dependency tree for the whole project.

---

## Layer 2: The Full Application (Optional)

**What it is:** A separate repo or subdirectory that builds the Buzz-like experience:
- Desktop app (Tauri + React, or web-only)
- Human orchestrator UI (channel view, agent list, delegation management)
- Optional self-hosted relay (not yet built — would be TypeScript, matching the rest of the stack)
- Optional Postgres for persistence and search

**What it consumes:**
- The same event kinds (47000–47099)
- The same Nostr relays (public or a self-hosted one, once built)
- The same SDK (`@fezchat/protocol`) for its own built-in agents

**Key principle:** The application is just **one more client** on the Nostr network. It doesn't own the protocol.

---

## Comparison: What Lives Where

| Feature | Minimal SDK (Layer 1) | Full Application (Layer 2) |
|---------|----------------------|------------------------------|
| Event kinds 47000+ | ✅ Defines and implements | ✅ Consumes |
| Keypair management | ✅ SDK function | ✅ UI + SDK |
| Relay connection | ✅ Any public/private relay | ✅ Bundled relay option |
| Agent spawning | ✅ Subprocess / function | ✅ Uses SDK |
| Task/progress/result | ✅ Core flow | ✅ UI visualization |
| Delegation signing | ✅ CLI `delegate` command | ✅ GUI delegation manager |
| Channel UI | ❌ Not applicable | ✅ Desktop/web app |
| Human chat | ❌ Not applicable | ✅ Part of the app |
| Audit logging | ❌ (on relay if present) | ✅ Postgres + UI |
| Budget tracking | ❌ (agent-local only) | ✅ Relay-enforced |
| Persistence | ❌ (relay handles it) | ✅ Postgres + relay |
| Search/indexing | ❌ (relay handles it) | ✅ Postgres FTS |

---

## The Developer Experience

### Solo Agent Builder

> "I want to build an agent that stores data on Hippius"

```bash
npm install fez-sdk
```

```typescript
// ditto.ts
import { Agent } from "fez-sdk";

const agent = await Agent.create({
  relay: "wss://relay.example.com",
  name: "ditto",
  supportedTasks: ["store"],
});

agent.onTask(async (task) => {
  const { data } = task.content;
  const hash = await hippius.store(data);
  return { storageUrl: `hippius://${hash}` };
});

agent.start();
```

```bash
npx tsx ditto.ts
```

Done. No relay, no database, no Docker. Just a TypeScript file and a Nostr relay URL.

### Team Using the Full App

> "We want a desktop app where our team can @mention agents in channels"

```bash
# Install the desktop app (DMG / AppImage / etc.)
# It bundles fez-sdk for its own agents
# It connects to our self-hosted relay or a public one
# It gives us a UI for delegation, task monitoring, agent discovery
```

The desktop app is just a **fancy Nostr client** that understands agent event kinds.

### Integration Builder

> "I want to add Fez support to my existing tool"

```typescript
import { AgentClient } from "fez-sdk/client";

// My tool can query agents, send tasks, and listen for results
const client = new AgentClient({ relay: "wss://relay.example.com" });
const agents = await client.discoverAgents({ capability: "storage" });
const result = await client.sendTask(agents[0], { type: "store", data: "..." });
```

---

## The Separation of Concerns

This split gives us three independent velocities:

1. **Protocol evolution** — Event kinds, delegation semantics, task flows. Changes slowly. Documented in Markdown specs.

2. **SDK evolution** — New adapter patterns, better DX, new language bindings. Changes quickly. Published to npm.

3. **Application evolution** — UI features, new layouts, human-facing workflows. Changes fastest. Separate release cycle.

An agent built against `fez-sdk@1.0.0` will still work when the desktop app is on `v5.2.0` because the **protocol (event kinds) is stable**.

---

## Why This Is Better Than Buzz's Monolith

Buzz is a single repo with everything coupled:
- Desktop app depends on Tauri Rust build
- Mobile depends on Flutter
- Relay depends on Postgres + Redis
- All 30+ crates build together

Fez separates the layers:
- **Protocol** — Just markdown specs (docs/protocol/)
- **SDK** — Lightweight Node.js package
- **Relay** — Optional, self-hosted, not yet built (only if you want your own)
- **Application** — Optional desktop/web product

A Python developer can build an agent without touching this repo's toolchain at all — the protocol is just signed JSON over a WebSocket. A TypeScript developer can integrate the SDK without touching Docker. A team that wants the full product can deploy the relay + app once they exist.

**The protocol is the center of gravity, not the codebase.**
