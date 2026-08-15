#!/usr/bin/env node
import chalk from "chalk";
import {
  Container,
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  editorTheme,
  loaderColors,
  markdownTheme,
} from "../packages/fez-tui/dist/index.js";
import { CapabilityClient } from "./client.js";
import { Agent } from "./agent.js";
import { RelayConnection } from "./relay.js";
import { KIND_AGENT_RESULT, KIND_AGENT_PROGRESS, KIND_AGENT_METADATA } from "./kinds.js";
import { findHarness, detectHarnesses, listHarnesses, registerBuiltinHarnesses } from "./harness.js";
import { loadExtensions } from "./extensions.js";
import { footer } from "./status.js";
import { findPersona } from "./personas.js";
import { findMcpServer } from "./mcp-servers.js";
import { findCommand } from "./commands.js";
import { setNoticeSink } from "./notices.js";
import type { Event } from "nostr-tools";
import type { McpServer } from "@agentclientprotocol/sdk";
import fs from "fs/promises";
import path from "path";
import os from "os";

const FEZ_DIR = path.join(os.homedir(), ".fez");

interface Message {
  id: string;
  author: "user" | "orchestrator" | string; // string = agent name
  content: string;
  timestamp: Date;
  status?: "pending" | "working" | "done" | "error";
  /** Id of the message this one is responding to — set on chained agent replies. */
  replyTo?: string;
  reactions?: { emoji: string; by: string }[];
}

/** Caps agent-mentions-agent chains (e.g. @researcher -> @reviewer -> ...) so a mutual-mention loop can't run forever. */
const MAX_CHAIN_DEPTH = 5;

/**
 * Minimal Fez TUI — chat-first terminal interface.
 *
 * Run with: `fez` (no arguments)
 *
 * Features:
 * - Chat interface (like pi / Claude Code)
 * - @mention routing to agents
 * - Local orchestrator for basic chat and routing
 * - Real-time result display
 */
export class FezTUI {
  private client: CapabilityClient;
  private relay: RelayConnection;
  private messages: Message[] = [];
  private myPubkey: string;
  private agentNameMap: Map<string, string> = new Map(); // pubkey -> name

  // Owned-terminal rendering (pi-tui engine via fez-tui). The screen owns
  // raw-mode stdin for the whole session — readline is gone entirely; that
  // was the one-ownership-model resolution to the conflict recorded in
  // packages/fez-tui/README.md.
  private screen!: TuiAltScreen;
  private log = new Container();
  private editor!: Editor;

  constructor(private relayUrl: string, privateKey?: string) {
    this.client = new CapabilityClient({ relay: relayUrl, privateKey });
    this.relay = new RelayConnection({ url: relayUrl });
    this.myPubkey = this.client.getPubkey();
  }

  private resolveQuit?: () => void;

  async start(): Promise<void> {
    await this.client.connect();
    await this.relay.connect();

    // Load default key if exists
    await this.ensureKey();

    // Subscribe to results and progress
    this.subscribeToEvents();

    // Register built-ins, then user extensions (~/.fez/extensions/*) through
    // the exact same registerHarness() call — built-ins have no special
    // path. Then detect what's actually installed so @mentions can dispatch
    // locally without a relay round-trip. All of this runs BEFORE the
    // screen takes raw-mode ownership: any console output these emit
    // (duplicate-registration warnings, failed extension loads) still goes
    // to plain stdout where it can't corrupt an owned-terminal render.
    // Extensions' ui.setStatus() calls during init are held by the Footer
    // and appear once it attaches below.
    registerBuiltinHarnesses();
    await loadExtensions();
    const harnesses = await detectHarnesses();

    // Owned-terminal UI, full-window chat shape: the message log fills all
    // remaining height inside a ScrollView glued to the newest message
    // (follow: "end" — scroll up to read history, it re-glues at bottom),
    // editor and footer pinned below at natural height. Alt-screen means
    // no native terminal scrollback (like vim) — pi-tui's own wheel
    // scrolling/search/selection replace it, and the shell's history is
    // restored intact on quit. screen.start() flips stdin to raw mode —
    // from here on, all output must go through the component tree.
    const terminal = new ProcessTerminal();
    this.screen = new TuiAltScreen(terminal, true, undefined, { mouse: true });
    this.editor = new Editor(this.screen, editorTheme);
    this.editor.onSubmit = (text) => void this.onSubmit(text);
    const layout = new VStack();
    layout.addChild(new ScrollView(this.log, { follow: "end" }), { grow: 1 });
    layout.addChild(this.editor);
    layout.addChild(footer.attach(this.screen));
    this.screen.setLayoutRoot(layout);
    this.screen.start();
    this.screen.setFocus(this.editor);

    // Mid-session warnings (harness stop-reasons, bad persona files) render
    // into the chat log instead of smearing raw stderr over the owned screen.
    setNoticeSink((text) => this.systemLine(text));

    footer.setStatus("relay", this.relayUrl);
    footer.setStatus("pubkey", `${this.myPubkey.slice(0, 12)}...`);

    this.renderHeader();

    // Initial greeting
    const harnessLine =
      harnesses.length > 0
        ? `Local harnesses ready: ${harnesses.map((h) => `@${h.aliases[0] ?? h.id}`).join(", ")}`
        : `No local harnesses detected (checked: ${listHarnesses().map((h) => h.command).join(", ")})`;

    this.addMessage({
      id: "welcome",
      author: "orchestrator",
      content: `Welcome to Fez! 🧢\n\n${harnessLine}\n\nI can chat with you and route @mentions to agents.\nType @agent-name to call an agent, or try:\n  fez install <package>  — install an agent\n  fez discover           — find agents on the network\n  /quit                  — exit`,
      timestamp: new Date(),
    });

    // Block until user quits
    return new Promise((resolve) => {
      this.resolveQuit = resolve;
    });
  }

  /** Editor submit handler — replaces readline's "line" event. */
  private async onSubmit(text: string): Promise<void> {
    const input = text.trim();
    this.editor.setText("");
    if (!input) return;
    this.editor.addToHistory(input);
    await this.handleInput(input);
  }

  private async handleInput(input: string): Promise<void> {
    if (!input) return;

    // Slash commands
    if (input.startsWith("/")) {
      await this.handleCommand(input);
      return;
    }

    // Add user message
    const msgId = Math.random().toString(36).slice(2);
    this.addMessage({
      id: msgId,
      author: "user",
      content: input,
      timestamp: new Date(),
    });

    // Check for @mentions
    const mention = this.parseMention(input);

    if (mention) {
      await this.routeToAgent(mention.agent, mention.instruction, msgId);
    } else {
      // Local orchestrator response
      await this.orchestratorResponse(input, msgId);
    }
  }

  private parseMention(input: string): { agent: string; instruction: string } | null {
    const match = input.match(/^@([\w-]+)(?:\s+(.+))?$/);
    if (match) {
      return {
        agent: match[1],
        instruction: match[2] || "help",
      };
    }
    // Also match inline mentions like "@ditto store this"
    const inlineMatch = input.match(/@([\w-]+)/);
    if (inlineMatch) {
      return {
        agent: inlineMatch[1],
        instruction: input.replace(/@[\w-]+\s*/, "").trim() || "help",
      };
    }
    return null;
  }

  private async routeToAgent(
    agentName: string,
    instruction: string,
    triggeringMsgId: string,
    depth = 0
  ): Promise<void> {
    // routingMsg is bookkeeping only — never printed directly. A live spinner
    // shows work-in-progress (Buzz's TypingIndicatorRow does the same "X is
    // typing..." thing); the eventual reply is what gets printed, once, as a
    // normal chat message.
    const routingMsg: Message = {
      id: `routing-${triggeringMsgId}`,
      author: agentName,
      content: "",
      timestamp: new Date(),
      status: "pending",
    };
    this.recordMessage(routingMsg);

    const triggeredBy =
      depth > 0 ? this.messages.find((m) => m.id === triggeringMsgId)?.author : undefined;
    const openingLine = triggeredBy
      ? `@${agentName} (mentioned by @${triggeredBy}) is thinking...`
      : `@${agentName} is thinking...`;
    const spinner = this.startLoader(openingLine);

    // Resolution order: named persona (a harness + system prompt the user
    // configured) -> bare harness by id -> Nostr agent discovery. Personas
    // and harnesses both dispatch locally, no relay round-trip.
    const persona = await findPersona(agentName);
    const harness = persona ? findHarness(persona.harness) : findHarness(agentName);

    if (harness) {
      const label = persona ? persona.id : harness.id;
      const fullInstruction = persona?.systemPrompt
        ? `${persona.systemPrompt}\n\n${instruction}`
        : instruction;

      // Resolve the persona's declared skill names against whatever's
      // actually registered (built in or via an extension) — an unresolved
      // name is dropped with a warning, not a hard failure, same tolerance
      // as a missing harness or a failed extension load elsewhere.
      const mcpServers = (persona?.mcpServers ?? [])
        .map((name) => {
          const server = findMcpServer(name);
          if (!server) this.systemLine(`⚠️  @${label} wants MCP server "${name}" but nothing registered it`);
          return server;
        })
        .filter((s): s is McpServer => s !== undefined);

      try {
        const result = await harness.invoke(
          fullInstruction,
          process.cwd(),
          (textSoFar) => {
            const preview = this.truncate(textSoFar, 70);
            spinner.setMessage(preview ? `@${label}: ${preview}` : openingLine);
          },
          mcpServers
        );
        this.stopLoader(spinner);
        this.updateMessage(routingMsg.id, { content: result, status: "done" });
        this.printReply(label, result, chalk.bold.green, triggeredBy);
        await this.handleAgentReply(result, label, triggeringMsgId, routingMsg.id, depth);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.failLoader(spinner, `@${label} failed: ${message}`);
        this.updateMessage(routingMsg.id, { content: message, status: "error" });
      }
      return;
    }

    // Resolve agent over Nostr
    const agents = await this.client.findAgentsByName(agentName);

    if (agents.length === 0) {
      this.failLoader(
        spinner,
        `No agent named "${agentName}" found. Try: fez discover --name ${agentName}, or fez install ${agentName}`
      );
      this.updateMessage(routingMsg.id, { content: "not found", status: "error" });
      return;
    }

    const target = agents[0];
    this.agentNameMap.set(target.pubkey, target.name);

    try {
      const result = await this.client.sendTask({
        to: target.pubkey,
        taskType: "auto",
        instruction,
        onProgress: (event) => {
          try {
            const content = JSON.parse(event.content);
            const pct = content.percent_complete ? ` (${content.percent_complete}%)` : "";
            spinner.setMessage(`@${target.name}: ${content.message || "working..."}${pct}`);
          } catch {
            // ignore
          }
        },
      });

      this.stopLoader(spinner);
      if (result.status === "success") {
        const rawText =
          typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? "", null, 2);
        const costNote = result.cost ? `\n${chalk.dim(`Cost: ${result.cost.amount} ${result.cost.currency}`)}` : "";
        this.updateMessage(routingMsg.id, { content: rawText, status: "done" });
        this.printReply(target.name, rawText + costNote, chalk.bold.green, triggeredBy);
        await this.handleAgentReply(rawText, target.name, triggeringMsgId, routingMsg.id, depth);
      } else {
        const message = result.error?.message || "Unknown error";
        this.updateMessage(routingMsg.id, { content: message, status: "error" });
        this.printReply(target.name, `Failed: ${message}`, chalk.bold.red, triggeredBy);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failLoader(spinner, `@${target.name} failed: ${message}`);
      this.updateMessage(routingMsg.id, { content: message, status: "error" });
    }
  }

  /** Live "agent is working" line — a pi-tui Loader added to the log, removed again on stop/fail. */
  private startLoader(text: string): Loader {
    const loader = new Loader(this.screen, loaderColors.spinner, loaderColors.message, text);
    this.log.addChild(loader);
    loader.start();
    this.screen.requestRender();
    return loader;
  }

  private stopLoader(loader: Loader): void {
    loader.stop();
    this.log.removeChild(loader);
    this.screen.requestRender();
  }

  private failLoader(loader: Loader, text: string): void {
    this.stopLoader(loader);
    this.log.addChild(new Text(chalk.red("✗ ") + text));
    this.screen.requestRender();
  }

  /**
   * Runs after any successful agent reply, human-triggered or chained.
   * Reacts to whatever message caused this agent to engage, then — same
   * mechanism, no special-casing — checks the reply's own text for another
   * @mention and routes to it if found. This is how "@researcher ... then
   * message @reviewer" resolves: @reviewer isn't dispatched by parsing your
   * original instruction upfront, it's triggered because @researcher's own
   * reply happened to mention it, exactly like a human's message would.
   */
  private async handleAgentReply(
    replyText: string,
    fromLabel: string,
    triggeringMsgId: string,
    replyMsgId: string,
    depth: number
  ): Promise<void> {
    this.addReaction(triggeringMsgId, "✅", fromLabel);

    if (depth >= MAX_CHAIN_DEPTH) return;

    const mention = this.parseMention(replyText);
    if (!mention) return;
    if (mention.agent.toLowerCase() === fromLabel.toLowerCase()) return; // no self-mentions

    await this.routeToAgent(mention.agent, mention.instruction, replyMsgId, depth + 1);
  }

  /** Data-only — the reaction shows up as a pill under the message it's attached to (see printReply), not as its own line. */
  private addReaction(messageId: string, emoji: string, by: string): void {
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    this.messages[idx].reactions = [...(this.messages[idx].reactions ?? []), { emoji, by }];
  }

  private truncate(text: string, max = 60): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  }

  /**
   * Prints one chat bubble: bold name header, content below — matches
   * Buzz's MessageAuthorText + body layout. When triggeredBy is set (a
   * chained reply), shows a ✅ reaction note — the visible form of the
   * reaction addReaction() recorded on the triggering message.
   */
  private printReply(
    displayName: string,
    content: string,
    color: (s: string) => string,
    triggeredBy?: string
  ): void {
    const reactionNote = triggeredBy ? chalk.dim(` ✅ responding to @${triggeredBy}`) : "";
    this.log.addChild(new Text("\n" + color(`@${displayName}`) + reactionNote));
    this.log.addChild(new Markdown(content, 0, 0, markdownTheme));
    this.screen.requestRender();
  }

  private async orchestratorResponse(input: string, parentMsgId: string): Promise<void> {
    // Minimal orchestrator — just basic responses for now
    // In the future, this calls needle or a local LLM

    const lower = input.toLowerCase();

    let response: string;

    if (lower.includes("hello") || lower.includes("hi")) {
      response = "Hey there! 👋 I'm the Fez orchestrator. I can chat and help you find agents. Try `@echo hello` to test the echo agent.";
    } else if (lower.includes("help")) {
      response = `Here's what you can do:\n\n• Chat with me (I'm basic, but friendly)\n• @mention agents: @echo hello\n• Install agents: fez install <name>\n• Discover agents: fez discover\n• Slash commands: /quit, /discover, /agents\n\nFor serious work, install some agents!`;
    } else if (lower.includes("install")) {
      response = "To install an agent, exit the TUI and run:\n  fez install <package-name>\n\nTry:\n  fez install claude-code\n  fez install echo";
    } else if (lower.includes("discover")) {
      response = "Let me check what agents are on the network...";
      // Trigger discovery
      setTimeout(async () => {
        const agents = await this.client.findAgentsByName("");
        const names = agents.map((a) => `@${a.name}`).join(", ");
        this.addMessage({
          id: `discover-${parentMsgId}`,
          author: "orchestrator",
          content: agents.length > 0
            ? `Found agents: ${names || "none yet"}`
            : "No agents found on the network. Be the first! Run `fez run echo-agent.ts`",
          timestamp: new Date(),
        });
      }, 500);
      return;
    } else {
      response = `I'm the local orchestrator — not very smart yet. I can:\n\n• Route @mentions to agents\n• Help you discover and install agents\n\nTry: @echo hello\nOr: /help`;
    }

    this.addMessage({
      id: `reply-${parentMsgId}`,
      author: "orchestrator",
      content: response,
      timestamp: new Date(),
    });
  }

  private async handleCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(" ");
    const cmd = parts[0];

    switch (cmd) {
      case "quit":
      case "q":
        this.shutdown();
        this.resolveQuit?.();
        break;

      case "discover":
        this.addMessage({
          id: `cmd-discover`,
          author: "orchestrator",
          content: "Discovering agents...",
          timestamp: new Date(),
        });
        try {
          const agents = await this.client.findAgentsByName("");
          this.systemLine(`[debug] Found ${agents.length} agents`);
          const names = agents.map((a) => `  • @${a.name} (${a.pubkey.slice(0, 16)}...)`).join("\n");
          this.addMessage({
            id: `cmd-discover-result`,
            author: "orchestrator",
            content: agents.length > 0
              ? `Agents on the network:\n${names}`
              : "No agents found. Run `fez run echo-agent.ts` in another terminal!",
            timestamp: new Date(),
          });
        } catch (err) {
          this.addMessage({
            id: `cmd-discover-err`,
            author: "orchestrator",
            content: `Discovery error: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date(),
          });
        }
        break;

      case "agents":
      case "list":
        const installed = await this.getInstalledAgents();
        this.addMessage({
          id: `cmd-agents`,
          author: "orchestrator",
          content: installed.length > 0
            ? `Installed agents:\n${installed.map((a) => `  • ${a}`).join("\n")}`
            : "No agents installed. Run `fez install <name>` to add some.",
          timestamp: new Date(),
        });
        break;

      case "key":
        this.addMessage({
          id: `cmd-key`,
          author: "orchestrator",
          content: `Your pubkey: ${this.myPubkey}\nSave this key to reuse: ${path.join(FEZ_DIR, "default.key")}`,
          timestamp: new Date(),
        });
        break;

      case "help":
      case "h":
        this.addMessage({
          id: `cmd-help`,
          author: "orchestrator",
          content: `Commands:\n  /quit, /q       — exit\n  /discover       — find agents on the network\n  /agents, /list  — show installed agents\n  /key            — show your pubkey\n  /help           — this message`,
          timestamp: new Date(),
        });
        break;

      default: {
        const extensionCommand = findCommand(cmd);
        if (extensionCommand) {
          const args = parts.slice(1).join(" ");
          await extensionCommand(args, {
            reply: (content) =>
              this.addMessage({
                id: `cmd-${cmd}-${Math.random().toString(36).slice(2)}`,
                author: "orchestrator",
                content,
                timestamp: new Date(),
              }),
          });
          break;
        }
        this.addMessage({
          id: `cmd-unknown`,
          author: "orchestrator",
          content: `Unknown command: /${cmd}. Try /help`,
          timestamp: new Date(),
        });
      }
    }
  }

  private subscribeToEvents(): void {
    // Listen for progress and results
    this.relay.subscribe(
      [
        {
          kinds: [KIND_AGENT_RESULT, KIND_AGENT_PROGRESS],
          "#p": [this.myPubkey],
          since: Math.floor(Date.now() / 1000),
        },
        {
          kinds: [KIND_AGENT_METADATA],
          since: Math.floor(Date.now() / 1000),
        },
      ],
      (event) => {
        if (event.kind === KIND_AGENT_METADATA) {
          try {
            const content = JSON.parse(event.content);
            this.agentNameMap.set(event.pubkey, content.name || "unknown");
          } catch {
            // ignore
          }
        }
      }
    );
  }

  private addMessage(msg: Message): void {
    this.messages.push(msg);
    this.renderMessage(msg);
  }

  /** Push without rendering — for internal bookkeeping entries (routing placeholders) that a spinner represents instead. */
  private recordMessage(msg: Message): void {
    this.messages.push(msg);
  }

  /** Data-only. Nothing prints from an update — routeToAgent prints the final reply itself, once, via printReply. */
  private updateMessage(id: string, updates: Partial<Message>): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx >= 0) {
      this.messages[idx] = { ...this.messages[idx], ...updates };
    }
  }

  /** Chat-bubble layout: bold name header, content below, no per-line timestamp — matches Buzz's MessageAuthorText pattern. */
  private renderMessage(msg: Message): void {
    let header: string;
    if (msg.author === "user") {
      header = chalk.bold.blue("You");
    } else if (msg.author === "orchestrator") {
      header = chalk.bold.magenta("Fez");
    } else {
      const color = msg.status === "error" ? chalk.bold.red : chalk.bold.green;
      header = color(`@${msg.author}`);
    }
    this.log.addChild(new Text("\n" + header));
    this.log.addChild(new Markdown(msg.content, 0, 0, markdownTheme));
    this.screen.requestRender();
  }

  /** A dim one-liner outside the chat-bubble shape — startup notes, routing warnings. */
  private systemLine(text: string): void {
    this.log.addChild(new Text(chalk.dim(text)));
    this.screen.requestRender();
  }

  private renderHeader(): void {
    this.log.addChild(
      new Text(
        chalk.bold("🧢 Fez — Decentralized MCP for Agents") +
          "\n" +
          chalk.dim(`Relay: ${this.relayUrl}`) +
          "\n" +
          chalk.dim(`Pubkey: ${this.myPubkey.slice(0, 16)}...`) +
          "\n" +
          chalk.dim("—".repeat(50))
      )
    );
    this.screen.requestRender();
  }

  private async ensureKey(): Promise<void> {
    const keyPath = path.join(FEZ_DIR, "default.key");
    try {
      await fs.access(keyPath);
    } catch {
      // No key yet — will use auto-generated
    }
  }

  private async getInstalledAgents(): Promise<string[]> {
    try {
      const registryPath = path.join(FEZ_DIR, "registry.json");
      const content = await fs.readFile(registryPath, "utf-8");
      const data = JSON.parse(content);
      return Object.keys(data.packages || {});
    } catch {
      return [];
    }
  }

  private shutdown(): void {
    // screen.stop() restores the terminal (raw mode off, cursor visible)
    // — after it, plain console output is safe again.
    setNoticeSink((text) => console.error(text));
    footer.detach();
    this.screen.stop();
    console.log(chalk.dim("\n👋 Goodbye!"));
    this.client.disconnect();
    this.relay.disconnect();
  }
}
