#!/usr/bin/env node
import readline from "readline";
import chalk from "chalk";
import { CapabilityClient } from "./client.js";
import { Agent } from "./agent.js";
import { RelayConnection } from "./relay.js";
import { KIND_AGENT_RESULT, KIND_AGENT_PROGRESS, KIND_AGENT_METADATA } from "./kinds.js";
import { findHarness, detectHarnesses, listHarnesses, registerBuiltinHarnesses } from "./harness.js";
import { loadExtensions } from "./extensions.js";
import { findPersona } from "./personas.js";
import type { Event } from "nostr-tools";
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
  private rl?: readline.Interface;
  private myPubkey: string;
  private agentNameMap: Map<string, string> = new Map(); // pubkey -> name
  private pendingTasks: Map<string, Message> = new Map(); // taskId -> message

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

    // Show header
    this.renderHeader();

    // Register built-ins, then user extensions (~/.fez/extensions/*) through
    // the exact same registerHarness() call — built-ins have no special
    // path. Then detect what's actually installed so @mentions can dispatch
    // locally without a relay round-trip.
    registerBuiltinHarnesses();
    await loadExtensions();
    console.log(chalk.dim("Checking for installed harnesses..."));
    const harnesses = await detectHarnesses();

    // Start input loop
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan("> "),
    });

    this.rl.on("line", async (line) => {
      await this.handleInput(line.trim());
      this.rl?.prompt();
    });

    this.rl.on("close", () => {
      this.shutdown();
      this.resolveQuit?.();
    });

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

    this.rl.prompt();

    // Block until user quits
    return new Promise((resolve) => {
      this.resolveQuit = resolve;
    });
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
    // Show "routing" message
    const routingMsg: Message = {
      id: `routing-${triggeringMsgId}`,
      author: "orchestrator",
      content: `Routing to @${agentName}...`,
      timestamp: new Date(),
      status: "pending",
    };
    this.addMessage(routingMsg);

    // Resolution order: named persona (a harness + system prompt the user
    // configured) -> bare harness by id -> Nostr agent discovery. Personas
    // and harnesses both dispatch locally, no relay round-trip.
    const persona = await findPersona(agentName);
    const harness = persona ? findHarness(persona.harness) : findHarness(agentName);

    if (harness) {
      const label = persona ? persona.id : harness.id;
      this.updateMessage(routingMsg.id, {
        content: `🔄 @${label} is working (local)...`,
        status: "working",
      });

      const fullInstruction = persona?.systemPrompt
        ? `${persona.systemPrompt}\n\n${instruction}`
        : instruction;

      try {
        const result = await harness.invoke(fullInstruction, process.cwd());
        this.updateMessage(routingMsg.id, {
          content: `✅ @${label}:\n${result}`,
          status: "done",
        });
        await this.handleAgentReply(result, label, triggeringMsgId, routingMsg.id, depth);
      } catch (err) {
        this.updateMessage(routingMsg.id, {
          content: `❌ @${label} failed: ${err instanceof Error ? err.message : String(err)}`,
          status: "error",
        });
      }
      return;
    }

    // Resolve agent
    const agents = await this.client.findAgentsByName(agentName);

    if (agents.length === 0) {
      this.updateMessage(routingMsg.id, {
        content: `❌ No agent named "${agentName}" found.\n\nTry:\n  fez discover --name ${agentName}\n  fez install ${agentName}`,
        status: "error",
      });
      return;
    }

    const target = agents[0];
    this.agentNameMap.set(target.pubkey, target.name);

    // Update to "working"
    this.updateMessage(routingMsg.id, {
      content: `🔄 @${target.name} is working...`,
      status: "working",
    });

    // Store as pending task
    this.pendingTasks.set(routingMsg.id, routingMsg);

    // Send task
    try {
      const result = await this.client.sendTask({
        to: target.pubkey,
        taskType: "auto",
        instruction,
        onProgress: (event) => {
          try {
            const content = JSON.parse(event.content);
            this.updateMessage(routingMsg.id, {
              content: `🔄 @${target.name}: ${content.message || "working..."} (${content.percent_complete || 0}%)`,
              status: "working",
            });
          } catch {
            // ignore
          }
        },
      });

      // Display result
      const resultContent = this.formatResult(target.name, result);
      this.updateMessage(routingMsg.id, {
        content: resultContent,
        status: "done",
      });

      if (result.status === "success") {
        const rawText =
          typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? "");
        await this.handleAgentReply(rawText, target.name, triggeringMsgId, routingMsg.id, depth);
      }
    } catch (err) {
      this.updateMessage(routingMsg.id, {
        content: `❌ @${target.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        status: "error",
      });
    }
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

  private addReaction(messageId: string, emoji: string, by: string): void {
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const msg = this.messages[idx];
    msg.reactions = [...(msg.reactions ?? []), { emoji, by }];
    console.log(chalk.dim(`   ${emoji} @${by} → "${this.truncate(msg.content)}"`));
  }

  private truncate(text: string, max = 60): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
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
          console.log(chalk.dim(`[debug] Found ${agents.length} agents`));
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

      default:
        this.addMessage({
          id: `cmd-unknown`,
          author: "orchestrator",
          content: `Unknown command: /${cmd}. Try /help`,
          timestamp: new Date(),
        });
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

  private formatResult(agentName: string, result: any): string {
    if (result.status === "success") {
      let text = `✅ @${agentName}:`;
      if (result.result) {
        const resultStr = typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result, null, 2);
        text += `\n${resultStr}`;
      }
      if (result.cost) {
        text += `\n${chalk.dim(`Cost: ${result.cost.amount} ${result.cost.currency}`)}`;
      }
      return text;
    } else {
      return `❌ @${agentName} failed: ${result.error?.message || "Unknown error"}`;
    }
  }

  private addMessage(msg: Message): void {
    this.messages.push(msg);
    this.renderMessage(msg);
  }

  private updateMessage(id: string, updates: Partial<Message>): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx >= 0) {
      this.messages[idx] = { ...this.messages[idx], ...updates };
      // Re-render (simple: just print update)
      const msg = this.messages[idx];
      const prefix = msg.author === "orchestrator"
        ? chalk.magenta("🤖 ")
        : chalk.green(`🤖 @${msg.author} `);
      console.log(prefix + updates.content);
    }
  }

  private renderMessage(msg: Message): void {
    const time = chalk.dim(msg.timestamp.toLocaleTimeString());

    if (msg.author === "user") {
      console.log(`${time} ${chalk.blue("You:")} ${msg.content}`);
    } else if (msg.author === "orchestrator") {
      console.log(`${time} ${chalk.magenta("🤖")} ${msg.content}`);
    } else {
      const color = msg.status === "error" ? chalk.red : chalk.green;
      console.log(`${time} ${color(`🤖 @${msg.author}`)} ${msg.content}`);
    }
  }

  private renderHeader(): void {
    console.clear();
    console.log(chalk.bold("🧢 Fez — Decentralized MCP for Agents"));
    console.log(chalk.dim(`Relay: ${this.relayUrl}`));
    console.log(chalk.dim(`Pubkey: ${this.myPubkey.slice(0, 16)}...`));
    console.log(chalk.dim("—".repeat(50)));
    console.log();
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
    console.log(chalk.dim("\n👋 Goodbye!"));
    this.rl?.close();
    this.client.disconnect();
    this.relay.disconnect();
  }
}
