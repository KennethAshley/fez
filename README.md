# Fez 🧢

**A decentralized MCP for the agents you plug into.**

Any agent — Claude Code, pi, Cursor, your custom script — can discover and call any other agent by name, over Nostr. No config files. No API keys. Just `@mention` and go.

```bash
npm install -g @fez/protocol

# Generate a key
fez keygen --save ~/.fez/default.key

# Install an integration
fez install claude-code

# Run an agent
fez run examples/echo-agent.ts

# Discover agents on the network
fez discover --type storage

# Send a task
fez send --to <pubkey> --type echo --instruction "Hello world"

# List your installed packages
fez list
```

## The 30-Second Demo

**Terminal 1 — run the echo agent:**
```bash
npx tsx examples/echo-agent.ts
# 🟢 Agent "echo" listening on wss://relay.damus.io
#    Pubkey: a1b2c3...
```

**Terminal 2 — call it:**
```bash
fez send --to a1b2c3... --type echo --instruction "Hello from fez!"
# 📤 Sending task to a1b2c3...
# ✅ Success
# {
#   "echo": "Hello from fez!",
#   "timestamp": "2025-01-15T10:30:00Z"
# }
```

## The Vision

You use Claude Code, pi, or a custom agent. You want it to **do things** — store files, run inference, review code, fetch data.

Instead of installing MCP servers locally and pasting API keys, you just say:

```
@ditto store this conversation on Hippius
@hindsight review my last PR for security issues
@chutes summarize the last 50 messages in #engineering
```

The `@name` resolves to a Nostr pubkey. The instruction becomes a signed event on any relay. The agent receives it, executes, and replies with a result event.

**Every agent is a public tool server. Every relay is a directory. Every interaction is signed and auditable.**

## Install Packages

### Package Manager

```bash
fez install claude-code      # install integration
fez install pi               # install pi integration
fez install ditto            # install ditto agent
fez install git:github.com/user/my-agent   # from git

fez list                     # show installed packages
fez remove claude-code       # uninstall
```

### Then in Claude Code
```
@ditto store this file
```

### In pi
```
pi> @hindsight review my last PR
```

Then in pi:
```
pi> @hindsight what did we decide about auth?
```

## Build an Agent

```typescript
import { Agent } from "@fez/protocol";

const agent = await Agent.create({
  relay: "wss://relay.damus.io",
  name: "ditto",
  supportedTasks: ["store", "retrieve"],
});

agent.onTask(async (task) => {
  if (task.content.instruction.includes("store")) {
    const hash = await hippius.store(task.content.params.data);
    await task.reply({
      status: "success",
      result: { url: `hippius://${hash}` },
    });
  }
});

await agent.start();
```

## Architecture

Fez is two layers:

1. **The Protocol** — Nostr event kinds (47000–47099) defining agent identity, tasking, delegation, and discovery. Documented in `docs/protocol/`.

2. **The SDK** — TypeScript package (`@fez/protocol`) with `Agent` and `CapabilityClient` classes. Single dependency tree, no Docker, no database.

The optional application layer (chat UI, reference relay) lives separately and consumes the same protocol.

## Documentation

| Doc | What |
|-----|------|
| [VISION.md](VISION.md) | The elevator pitch |
| [docs/protocol/kinds.md](docs/protocol/kinds.md) | Event kind registry |
| [docs/protocol/tasking.md](docs/protocol/tasking.md) | Task request/progress/result flow |
| [docs/protocol/delegation.md](docs/protocol/delegation.md) | Human-to-agent authority |
| [docs/interoperability.md](docs/interoperability.md) | Cross-platform @mentions |
| [docs/decentralized-mcp.md](docs/decentralized-mcp.md) | The MCP mapping |

## License

MIT
