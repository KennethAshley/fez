# The Orchestrator Pattern

## Two Faces of Fez

Fez has **two interfaces** that share the same protocol:

1. **Terminal UI** (`fez`) — Chat-first, runs in your terminal. Primary interface for developers.
2. **Web/Desktop App** — Buzz-like interface. Primary interface for teams and non-technical users.

Both talk to the same agents through the same Nostr events.

## The Orchestrator Agent

When you type `fez` and open the chat, there's always **one agent
listening** — the **Orchestrator**.

The Orchestrator is:
- A small tool-calling model behind an OpenAI-compatible URL. By default
  that's the hosted fez router (install nothing); point it at localhost
  and it's fully local instead. The seam does not change.
- NOT the one doing your work
- The one that **understands what you want and routes you to the right agent**

Local-first is still a first-class path, not a fallback — see
`packages/fez-orchestrator/README.md` for the three ways to fill the
seam and the measured trade-offs between them.

## What the Orchestrator Does

### 1. Conversational Discovery

```
You: I need to store some files
🤖 Orchestrator: You might want @ditto for storage on Hippius,
    or @ipfs-agent for IPFS pinning.
    
    Install either with:
    fez install ditto
    fez install ipfs-agent

You: what's the difference?
🤖 Orchestrator: Ditto uses Hippius (Bittensor subnet, costs TAO).
    IPFS Agent uses free public gateways.
    
    For small files, IPFS is cheaper.
    For large/durable storage, Ditto is more reliable.
```

### 2. Intent Routing

```
You: summarize the last 50 messages in #engineering
🤖 Orchestrator: (parses intent)
    
    Route: @chutes (inference agent)
    Context: { channel: "#engineering", last: 50 }
    
    🔄 Calling @chutes...
    🤖 Chutes: (result appears)
```

The Orchestrator doesn't summarize. It figures out you need summarization, finds an agent that does it, and routes the task.

### 3. Multi-Agent Coordination

```
You: review my PR, store the review, and summarize it
🤖 Orchestrator: This needs 3 agents:
    1. @review — code review
    2. @ditto — store the review
    3. @chutes — summarize the stored review
    
    🔄 Calling @review...
    🤖 Review: 3 issues found, 2 suggestions
    
    🔄 Calling @ditto to store...
    🤖 Ditto: ✅ Stored at hippius://abc123
    
    🔄 Calling @chutes to summarize...
    🤖 Chutes: "Review found 3 issues: missing tests (1), 
              performance concern (1), security note (1)."
```

The Orchestrator is the **conductor**. The agents are the **musicians**.

### 4. Fallback and Recovery

```
You: @ditto store this huge file (500MB)
🤖 Ditto: ❌ Error — file too large (max 100MB)

🤖 Orchestrator: Ditto can't handle files over 100MB.
    Alternatives:
    - Split into chunks (I can do that)
    - Use @large-file-agent (supports up to 1GB)
    - Use direct Hippius upload
```

## The Orchestrator is Also a Nostr Agent

Wait — the Orchestrator itself is just another agent. It:
- Has a Nostr pubkey
- Publishes `kind: 47000` metadata ("I'm the Fez Orchestrator")
- Subscribes to your messages (as events)
- Publishes responses (as events)

The difference from `@ditto`, `@review`, and the rest: nothing — `@fez`
is a standalone standing agent process, started the same way
(`fez run packages/fez-orchestrator/dist/orchestrator.js -r ws://...`),
not code embedded inside the TUI. It defaults to a **hosted** endpoint
(a fez-run router serving Qwen3-0.6B) so `@fez` works with nothing
installed; pointing `FEZ_ORCHESTRATOR_URL` at a local ollama or
llama.cpp server is equally first-class and changes nothing else. See
`packages/fez-orchestrator/README.md` for the full seam.

```
┌───────────────────────────┐
│   @fez orchestrator        │        (standalone process,
│   • pubkey: <service-key>  │         `fez run orchestrator.js`)
│   • model: any OpenAI-     │
│     compatible endpoint    │
│     (hosted by default)    │
│   • role: router only      │
└─────────────┬───────────────┘
              │
              ▼
       Nostr Event Bus
       (relay or p2p)
              │
      ┌───────┼────────┐
      ▼       ▼        ▼
  ┌───────┐┌───────┐┌────────┐   ┌──────────────┐
  │@ditto ││@review││@chutes │   │  fez TUI /   │
  └───────┘└───────┘└────────┘   │  Buzz client │
                                  └──────────────┘
```

## Why This Is Powerful

1. **Always works** — Even with no internet, the Orchestrator can chat and help.
2. **Progressive enhancement** — Add agents as you need them. The Orchestrator adapts.
3. **No vendor lock-in** — The Orchestrator can be a tiny local router today, a cloud model tomorrow. Same events, same protocol.
4. **Transparent** — The Orchestrator shows its reasoning: "I'm routing to @ditto because..."
5. **Composable** — Multiple Orchestrators can coordinate. Your phone's Fez app can ask your desktop's Fez app to run a heavy agent.

## The Buzz Interface

Eventually, the web/desktop app is just **another Orchestrator frontend**:

```
Web/Desktop App (React/Tauri)
  │
  ├── Same Nostr events
  ├── Same agent discovery
  ├── Same @mention routing
  └── But with: threads, channels, rich media, team management

Terminal App (fez)
  │
  ├── Same Nostr events
  ├── Same agent discovery
  ├── Same @mention routing
  └── But with: minimal UI, keyboard-driven, developer-focused
```

The **protocol is the constant**. The **interface is the variable**.

## The One-Sentence Vision

> **Fez is a chat interface where an orchestrator understands your intent, routes to specialized agents over Nostr, and progressively becomes smarter as you install more capabilities.**
