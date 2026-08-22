# Fez TUI — The Chat Interface

## The Core Idea

Typing `fez` opens a **minimal terminal chat interface** — like `pi` or Claude Code, but agent-native.

```
$ fez
fez — no agents installed yet

You: hello
🤖 Fez: Hi! I'm running locally on a tiny model. I can chat,
    but I'm not very smart. Install agents to get real work done.

You: @ditto store this conversation
🤖 Fez: I don't see a "ditto" agent installed. Want me to help
    you find one? Try: fez install ditto

You: fez install ditto
📦 Installing ditto...
✅ Installed ditto v1.2.0

You: @ditto store this conversation
🤖 Ditto: ✅ Stored at hippius://abc123
```

## Why a TUI?

Most tools in this space (`pi`, `claude`, `aider`) are **chat-first**. You open them and talk. Tools get invoked through natural language.

Fez should work the same way:
- `fez` → opens chat
- `@agent` → routes to that agent
- Plain text → either local model or routed to default agent

## The Default Agent (Needle / Local Model)

When `fez` starts with **nothing installed** and **no API keys configured**, it needs to still work. The answer: a **tiny local model** as the default agent.

### Why Needle (or similar)

| Property | Why it works |
|----------|-----------|
| 14MB model | Downloads instantly, runs on CPU |
| No API keys | Works offline, no cloud dependency |
| Good enough | Can parse @mentions, route tasks, basic chat |
| Privacy | Everything local until you route to cloud agents |

### How it works

```
┌─────────────────────────────────────────┐
│             fez TUI                      │
│                                          │
│  ┌──────────────┐  ┌──────────────┐     │
│  │ Chat UI      │  │ Input Box    │     │
│  │ (renders     │  │ (you type)   │     │
│  │  events)     │  │              │     │
│  └──────────────┘  └──────────────┘     │
│                                          │
│  ┌─────────────────────────────────────┐ │
│  │  Router                             │ │
│  │  • Parse input for @mentions        │ │
│  │  • If @found → route to agent       │ │
│  │  • If plain text → default agent    │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
              │
              ├──► Default Agent (needle / local LLM)
              │    ├─ Basic chat
              │    ├─ Parse @mentions
              │    └─ Suggest agents to install
              │
              └──► Installed Agents (@ditto, @hindsight)
                   ├─ Subscribe to tasks
                   ├─ Execute work
                   └─ Publish results
```

### The Local Model's Job

The local model is **not** doing the heavy lifting. Its job is:

1. **Chat** — basic conversation when no agents are installed
2. **Parse** — identify @mentions and route them
3. **Discover** — suggest what agents might help
4. **Install** — guide users through `fez install <package>`
5. **Fallback** — when an agent fails, explain what happened

```
You: what's the weather?
🤖 Fez: I don't have a weather agent installed. You could try:
    fez install weather
    
You: @ditto summarize #general
🤖 Fez: (routing to @ditto...)
🤖 Ditto: ✅ Here's the summary: ...
```

## TUI Architecture

The TUI is a **Nostr client** that renders events and publishes them.

```typescript
// Simplified architecture
class FezTUI {
  private relay: RelayConnection;
  private localAgent: LocalAgent;  // needle / tiny LLM
  private router: AgentRouter;
  private ui: ChatInterface;

  async start() {
    // Connect to relay
    await this.relay.connect();
    
    // Start local model (if no other default)
    this.localAgent = await LocalAgent.create();
    
    // Start UI
    this.ui = new ChatInterface();
    
    // Handle user input
    this.ui.onInput(async (text) => {
      await this.handleInput(text);
    });
    
    // Listen for results
    this.relay.subscribe(
      [{ kinds: [KIND_AGENT_RESULT], "#p": [this.myPubkey] }],
      (event) => this.renderResult(event)
    );
  }

  private async handleInput(text: string) {
    // 1. Check for @mentions
    const mention = parseMention(text);
    
    if (mention) {
      // Route to agent
      await this.router.routeToAgent(mention.agent, mention.instruction);
    } else {
      // Send to local model
      const response = await this.localAgent.chat(text);
      this.ui.renderAssistant(response);
    }
  }
}
```

## Modes of Operation

### Mode 1: Minimal (Nothing Installed)

```bash
$ fez
fez — running on needle (local, 14MB)

You: hello
🤖 Fez: Hi! I'm a tiny local model. I can chat and help you find
    agents, but for serious work you'll want to install some.

You: what can you do?
🤖 Fez: I can:
    - Chat with you (I'm not very smart though)
    - Parse @mentions and route to agents
    - Suggest agents to install
    
    Try: fez install ditto
    Or: @ditto (if already installed)
```

### Mode 2: With Installed Agents

```bash
$ fez
fez — 3 agents ready (@ditto, @hindsight, @chutes)

You: @ditto store this file
🤖 Ditto: ✅ Stored at hippius://abc123 (0.02 TAO)

You: what was that URL again?
🤖 Fez: Your last storage URL was hippius://abc123

You: @hindsight review it
🤖 Hindsight: The stored data contains no PII. Storage provider
    Hippius has good uptime (99.7%).
```

### Mode 3: With Cloud Model

```bash
$ fez --model claude-sonnet
fez — using Claude Sonnet via API

You: @ditto store this + @hindsight review it
🤖 Fez: (Claude parses the compound request)
🤖 Ditto: ✅ Stored
🤖 Hindsight: ✅ No issues found
```

## The Chat Interface

Simple. No sidebar, no panels, no complexity:

```
┌──────────────────────────────────────────────┐
│ fez — 3 agents │ ws://relay.damus.io        │
├──────────────────────────────────────────────┤
│                                              │
│ You: @ditto store this conversation          │
│                                              │
│ 🤖 Ditto: ●●● (working...)                    │
│                                              │
│ 🤖 Ditto: ✅ Done — hippius://abc123          │
│                                              │
│ You: thanks                                    │
│                                              │
│ 🤖 Fez: 👍                                     │
│                                              │
├──────────────────────────────────────────────┤
│ > _                                          │
│                                              │
└──────────────────────────────────────────────┘
```

### Key UI Elements

| Element | Shows |
|---------|-------|
| Header | Fez logo, connected agents count, relay URL |
| Chat log | Messages, agent responses, progress indicators |
| Input | `>` prompt where you type |
| Footer | Your pubkey, token usage (if cloud model) |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Enter | Send message |
| Shift+Enter | New line |
| Ctrl+C | Cancel in-flight agent |
| Ctrl+D | Quit |
| @ | Autocomplete agent names |
| / | Slash commands (/install, /discover, /settings) |

## Why This Is Better Than `fez send`

The current CLI is command-based:
```bash
fez send --to <pubkey> --type echo --instruction "Hello"
```

The TUI is conversation-based:
```
> @echo Hello
🤖 Echo: Hello
```

You don't need to know pubkeys. You don't need to remember flags. You just chat.

## Implementation Path

### Phase 1: Minimal TUI + Needle

1. `fez` starts a basic terminal UI
2. Integrates needle (or any tiny local model) as default agent
3. Handles basic chat and @mention parsing
4. Routes to installed agents when available

### Phase 2: Cloud Model Support

1. Add `--model` flag for cloud providers (Claude, OpenAI, etc.)
2. Local model becomes fallback, not primary
3. Better reasoning, better routing decisions

### Phase 3: Rich Agent UI

1. Agent status indicators (online/offline/working)
2. Inline tool output (like Claude Code's artifacts)
3. Result cards (storage URLs, summaries, etc.)
4. Agent marketplace browser (inside the TUI)

## Needle Integration

Needle is a 14MB Gemma model. To use it:

```typescript
import { Needle } from "@cactus/needle";

const model = await Needle.load();

// In the TUI router
async function handlePlainText(input: string) {
  const response = await model.generate(input, {
    system: "You are Fez, a helpful assistant. You can route to agents via @mentions."
  });
  return response;
}
```

Or use any local model runner:
- **needle** — 14MB, ultra-minimal
- **ollama** — pulls models on demand
- **llama.cpp** — runs GGUF files
- ** transformers.js** — in-browser models

The TUI just needs a `LocalModel` interface:

```typescript
interface LocalModel {
  generate(prompt: string, context?: string[]): Promise<string>;
}
```

## The Vision in One Sentence

> **Fez is a chat-first terminal app where a tiny local model handles basic conversation, @mentions route to specialized agents, and everything communicates via signed Nostr events.**
