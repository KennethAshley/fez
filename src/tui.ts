#!/usr/bin/env node
import chalk from "chalk";
import {

  Container,
  Editor,
  HStack,
  Loader,
  Markdown,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  authorColor,
  compileThemeJson,
  editorTheme,
  getActiveTheme,
  loaderColors,
  markdownTheme,
  setActiveTheme,
  SidePanel,
  timestamp,
  visibleWidth,
  applyBackgroundToLine,
  type Component,
  type FezTheme,
  type ThemeJson,
} from "../packages/fez-tui/dist/index.js";

/**
 * Per-line prefix wrapper (reddix's comment-tree recipe): the child
 * renders at a narrowed width and every produced line gets the prefix —
 * spaces for thread depth, two columns for message bodies under their
 * header. Prefixing rendered OUTPUT keeps markdown intact (indenting
 * markdown SOURCE four spaces would turn it into a code block).
 */
/**
 * Full-width block background behind a rendered component — pi-tui's own
 * ANSI-safe painter (applyBackgroundToLine, the mechanism inside Text's
 * customBgFn), applied to any child incl. Markdown. Powers the two-tone
 * timeline: userMessageBg behind yours, agentMessageBg behind theirs.
 */
class BlockBg implements Component {
  constructor(
    private child: Component & { invalidate?: () => void },
    private bgFn: () => (s: string) => string
  ) {}
  invalidate(): void {
    this.child.invalidate?.();
  }
  render(width: number): string[] {
    const bg = this.bgFn();
    return this.child.render(width).map((line) => applyBackgroundToLine(line, width, bg));
  }
}

/**
 * @mention coloring on rendered lines — "@researcher" pops in the
 * accent color inside any message body. Post-render so markdown parsing
 * never sees ANSI; fg-only close (chalk's 39) so a painted block
 * background survives the colored span.
 */
class MentionColor implements Component {
  constructor(private child: Component & { invalidate?: () => void }) {}
  invalidate(): void {
    this.child.invalidate?.();
  }
  render(width: number): string[] {
    const accent = getActiveTheme().accent;
    return this.child.render(width).map((line) => line.replace(/@[\w][\w-]*/g, (m) => accent(m)));
  }
}

class LinePrefix implements Component {
  private prefixWidth: number;
  constructor(
    private child: Component & { invalidate?: () => void },
    private prefix: string
  ) {
    this.prefixWidth = visibleWidth(prefix);
  }
  invalidate(): void {
    this.child.invalidate?.();
  }
  render(width: number): string[] {
    return this.child.render(Math.max(1, width - this.prefixWidth)).map((line) => this.prefix + line);
  }
}
import { CapabilityClient } from "./client.js";
import { FezClient } from "../packages/fez-client/dist/index.js";
import { installNodeStatePersistence } from "../packages/fez-client/dist/state-node.js";
import { Agent } from "./agent.js";
import { RelayConnection } from "./relay.js";
import { KIND_AGENT_RESULT, KIND_AGENT_PROGRESS, KIND_AGENT_METADATA } from "./kinds.js";
import { findHarness, detectHarnesses, listHarnesses, registerBuiltinHarnesses } from "./harness.js";
import { spawn } from "node:child_process";
import { loadExtensions, setNostrBackend, setUiBackend, setClientBackend, getInputHandlers, findUrlHandler, getRegisteredThemes, findTheme, registerTheme as registerThemePack, type MessageHandle } from "./extensions.js";
import { footer } from "./status.js";
import { findPersona } from "./personas.js";
import { findMcpServer } from "./mcp-servers.js";
import { findCommand, registerCommand } from "./commands.js";
import fsSync from "node:fs";
import { setNoticeSink } from "./notices.js";
import type { Event } from "nostr-tools";
import type { McpServer } from "@agentclientprotocol/sdk";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fetchRelayInfo } from "./nip11.js";

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
  private fezClient!: FezClient;
  private agentNameMap: Map<string, string> = new Map(); // pubkey -> name

  // Owned-terminal rendering (pi-tui engine via fez-tui). The screen owns
  // raw-mode stdin for the whole session — readline is gone entirely; that
  // was the one-ownership-model resolution to the conflict recorded in
  // packages/fez-tui/README.md.
  private screen!: TuiAltScreen;
  private log = new Container();
  private logScroll?: ScrollView;
  private scrollTopHandlers: (() => Promise<void>)[] = [];
  private editor!: Editor;
  // Full-height sidebar surface (atelier's renderDock pattern — emits
  // terminal-height rows every render). Extensions get sections via
  // ui.createSidePanel() during loadExtensions(), before the screen exists.
  private sidePanel = new SidePanel(() => process.stdout.rows ?? 24);
  // Per-message action registry: bubble id -> current content, backing the
  // clickable ⧉ (copy to clipboard) / ↩ (quote into editor) glyphs.
  private bubbleSeq = 0;
  private bubbleContents = new Map<string, string>();
  private sidePanelWidth = 26;
  private sidePanelUsed = false;
  // ui.appendMessage() calls made before screen.start() — flushed after.
  private pendingBubbles: { author: string; content: string }[] = [];
  private warnedMissingSkills = new Set<string>();

  private relayHealth: { url: string; connected: boolean }[] = [];

  private relayList(): string[] {
    return Array.isArray(this.relayUrls) ? this.relayUrls : [this.relayUrls];
  }

  /**
   * What the footer says about the relay set. One relay keeps the old
   * behaviour (its URL). Several report as a fraction, because the
   * number that matters is how many are actually carrying your events —
   * "connected" is true right up until you are down to your last relay.
   */
  private relayStatusText(): string {
    const urls = this.relayList();
    if (urls.length === 1) return urls[0];
    const up = this.relayHealth.filter((h) => h.connected).length;
    const total = this.relayHealth.length || urls.length;
    return `${up}/${total} relays`;
  }

  constructor(private relayUrls: string | string[], privateKey?: string) {
    installNodeStatePersistence(); // file-backed joined/scope state (~/.fez/communities.json)
    const urls = Array.isArray(relayUrls) ? relayUrls : [relayUrls];
    this.client = new CapabilityClient({ relay: urls, privateKey });
    this.relay = new RelayConnection({
      urls,
      authSigner: this.client.authSigner,
      // A relay set that has quietly become one relay looks exactly like
      // a healthy one unless something says so out loud.
      onRelayHealth: (health) => {
        this.relayHealth = health;
        footer.setStatus("relay", this.relayStatusText());
      },
    });
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

    // Backends behind FezExtensionAPI's nostr/ui surface, installed before
    // extensions load so their init-time calls land. The screen doesn't
    // exist yet: createSidePanel builds a real Text now (laid out later),
    // appendMessage buffers until after screen.start(). The SAME wire
    // object feeds both api.nostr and the process's one FezClient — the
    // headless protocol brain extensions render views over (api.client).
    const wire = {
      pubkey: this.myPubkey,
      publish: async (tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }) => {
        const event = this.client.signEvent(tmpl);
        await this.relay.publish(event);
        return event;
      },
      signEvent: (tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }) =>
        this.client.signEvent(tmpl),
      subscribe: (filters: Parameters<RelayConnection["subscribe"]>[0], onEvent: (event: Event) => void) =>
        this.relay.subscribe(filters, onEvent),
      query: (filters: Parameters<RelayConnection["query"]>[0]) => this.relay.query(filters),
      encrypt: (peer: string, plaintext: string) => this.client.encryptTo(peer, plaintext),
      decrypt: (peer: string, ciphertext: string) => this.client.decryptFrom(peer, ciphertext),
      sendGroupDm: async (recipients: string[], text: string) => {
        const { wraps, id } = this.client.wrapGroupDm(recipients, text);
        for (const wrap of wraps) await this.relay.publish(wrap);
        return id;
      },
      sendDm: async (recipient: string, text: string) => {
        const { toPeer, toSelf, id } = this.client.wrapDm(recipient, text);
        await this.relay.publish(toPeer);
        await this.relay.publish(toSelf);
        return id;
      },
      unwrapDm: (event: Event) => this.client.unwrapDm(event),
      // The workspace's identity card — who owns this relay. Asked of
      // the primary; extra URLs are mirrors of the same workspace.
      relayInfo: (relay?: string) => fetchRelayInfo(relay ?? this.relay.urls[0]),
    };
    setNostrBackend(wire);
    this.fezClient = new FezClient(wire);
    setClientBackend(this.fezClient);
    setUiBackend({
      createSidePanel: (opts) => {
        const section = this.sidePanel.addSection({ title: opts?.title, icon: opts?.icon, order: opts?.order });
        if (opts?.width) this.sidePanelWidth = opts.width;
        this.sidePanelUsed = true;
        return {
          setText: (t: string) => {
            this.sidePanel.setSection(section, t);
            this.screen?.requestRender();
          },
        };
      },
      appendMessage: (author, content, ts, opts) => this.appendBubble(author, content, ts, "append", opts),
      prependMessage: (author, content, ts, opts) => this.appendBubble(author, content, ts, "prepend", opts),
      onLogScrollTop: (handler) => this.scrollTopHandlers.push(handler),
      notify: (text) => this.systemLine(text),
      clearLog: () => {
        this.log.clear();
        this.screen?.requestRender();
      },
    });

    await loadExtensions();
    this.loadJsonThemes();
    this.initThemes();
    const harnesses = await detectHarnesses();

    // Owned-terminal UI, full-window chat shape: the message log fills all
    // remaining height inside a ScrollView glued to the newest message
    // (follow: "end" — scroll up to read history, it re-glues at bottom),
    // editor and footer pinned below at natural height. When extensions
    // registered side panels, the whole thing sits right of a fixed-width
    // panel column. Alt-screen means no native terminal scrollback (like
    // vim) — pi-tui's own wheel scrolling/search/selection replace it, and
    // the shell's history is restored intact on quit. screen.start() flips
    // stdin to raw mode — from here on, all output must go through the
    // component tree.
    const terminal = new ProcessTerminal();
    this.screen = new TuiAltScreen(terminal, true, undefined, {
      mouse: true,
      // OSC-8 hyperlink clicks: extensions claim custom schemes via
      // registerUrlHandler (e.g. a sidebar entry focusing a herdr tab);
      // unclaimed web links open in the system browser.
      openUrl: (url) => {
        // Per-message actions (the ⧉/↩ glyphs on every bubble): copy the
        // message to the system clipboard, or quote it into the editor.
        if (url.startsWith("fez-copy://") || url.startsWith("fez-quote://")) {
          const id = url.slice(url.indexOf("//") + 2);
          const content = this.bubbleContents.get(id);
          if (content === undefined) return;
          if (url.startsWith("fez-copy://")) {
            const pb = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
            pb.stdin?.on("error", () => {});
            pb.stdin?.end(content);
            footer.setStatus("clip", "⧉ copied");
            setTimeout(() => footer.setStatus("clip", ""), 2500);
          } else {
            const quoted = content.split("\n").map((l) => `> ${l}`).join("\n") + "\n";
            if (this.editor.insertTextAtCursor) this.editor.insertTextAtCursor(quoted);
            else this.editor.setText(this.editor.getText() + quoted);
          }
          this.screen.requestRender();
          return;
        }
        const handler = findUrlHandler(url);
        if (handler) {
          handler(url);
        } else if (/^https?:\/\//.test(url)) {
          spawn("open", [url], { stdio: "ignore", detached: true }).unref();
        }
      },
    });
    this.editor = new Editor(this.screen, editorTheme);
    this.editor.onSubmit = (text) => void this.onSubmit(text);
    const main = new VStack();
    // The log both grows AND shrinks; editor + footer are pinned
    // (shrink: 0). Without the pins, pi-tui's default shrink:1 squeezes
    // EVERY child once the log overflows the screen — observed live as
    // the input box vanishing the moment channel history backfilled.
    this.logScroll = new ScrollView(this.log, { follow: "end" });
    main.addChild(this.logScroll, { grow: 1, shrink: 1 });
    main.addChild(this.editor, { shrink: 0 });
    main.addChild(footer.attach(this.screen), { shrink: 0 });
    if (this.sidePanelUsed) {
      const root = new HStack([], { gap: 1 });
      root.addChild(this.sidePanel, { basis: this.sidePanelWidth });
      root.addChild(main, { grow: 1 });
      this.screen.setLayoutRoot(root);
    } else {
      this.screen.setLayoutRoot(main);
    }
    this.screen.start();
    this.screen.setFocus(this.editor);

    // The client starts AFTER extensions registered their event
    // listeners and the screen exists — its startup emissions (backfill
    // messages, notices, panel state) land on live views.
    void this.fezClient.start();

    // Load-older seam (Buzz's scroll-up channel paging, TUI-shaped):
    // when the user PARKS the log at the very top with real overflow,
    // fire the registered handlers once, let them prepend history, then
    // shift the viewport down by exactly the added height so the line
    // they were reading stays put. Re-arms when they scroll away from
    // the top — one page per visit, not a firehose.
    let atTopArmed = true;
    let loadingOlder = false;
    setInterval(() => {
      // contentHeight is a private field in pi-tui's typings but a plain
      // JS property — read it structurally for the compensation math.
      const scroll = this.logScroll as unknown as
        | { contentHeight: number; scrollTop: number; viewportHeight: number; scrollTo(top: number): void }
        | undefined;
      if (!scroll || this.scrollTopHandlers.length === 0 || loadingOlder) return;
      if (scroll.scrollTop > 0) {
        atTopArmed = true;
        return;
      }
      if (!atTopArmed || scroll.contentHeight <= scroll.viewportHeight) return;
      atTopArmed = false;
      loadingOlder = true;
      const beforeHeight = scroll.contentHeight;
      void Promise.allSettled(this.scrollTopHandlers.map((h) => h())).then(() => {
        this.screen.requestRender();
        // contentHeight refreshes during the next layout pass — measure
        // the delta after it and compensate so the view doesn't jump.
        setTimeout(() => {
          const delta = scroll.contentHeight - beforeHeight;
          if (delta > 0 && scroll.scrollTop === 0) scroll.scrollTo(delta);
          loadingOlder = false;
        }, 80);
      });
    }, 300).unref?.();

    // Flush ui.appendMessage calls that arrived before the screen existed.
    for (const bubble of this.pendingBubbles) this.appendBubble(bubble.author, bubble.content);
    this.pendingBubbles = [];

    // Mid-session warnings (harness stop-reasons, bad persona files) render
    // into the chat log instead of smearing raw stderr over the owned screen.
    setNoticeSink((text) => this.systemLine(text));

    footer.setStatus("relay", this.relayStatusText());
    footer.setStatus("pubkey", `${this.myPubkey.slice(0, 12)}...`);

    const harnessLine =
      harnesses.length > 0
        ? harnesses.map((h) => chalk.cyan(`@${h.aliases[0] ?? h.id}`)).join(chalk.dim(", "))
        : chalk.dim(`none detected (checked: ${listHarnesses().map((h) => h.command).join(", ")})`);
    this.renderHeader(harnessLine);

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

    // Extension input handlers (e.g. a communities extension claiming chat
    // while a channel scope is active) — first to return true owns the
    // input, including rendering its own "You" bubble.
    for (const handler of getInputHandlers()) {
      if (await handler(input)) return;
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
          // Warn once per persona+skill per session — repeating it under
          // every message is pure noise (seen in real use).
          const warnKey = `${label}:${name}`;
          if (!server && !this.warnedMissingSkills.has(warnKey)) {
            this.warnedMissingSkills.add(warnKey);
            this.systemLine(`⚠️  @${label} wants MCP server "${name}" but nothing registered it`);
          }
          return server;
        })
        .filter((s): s is McpServer => s !== undefined);

      // Stream the reply into a live bubble, pi-style: the Loader covers
      // the pre-first-token phase (tool calls, thinking); the moment text
      // arrives it's replaced by the reply bubble, which grows with every
      // throttled progress tick via its MessageHandle.
      let streamBubble: MessageHandle | undefined;
      try {
        const result = await harness.invoke(
          fullInstruction,
          process.cwd(),
          (textSoFar) => {
            if (!textSoFar) return;
            if (!streamBubble) {
              this.stopLoader(spinner);
              streamBubble = this.appendBubble(`@${label}`, textSoFar);
              if (triggeredBy) streamBubble.setFooter(`↳ responding to @${triggeredBy}`);
            } else {
              streamBubble.setContent(textSoFar);
            }
          },
          mcpServers
        );
        if (streamBubble) {
          streamBubble.setContent(result);
        } else {
          this.stopLoader(spinner);
          this.printReply(label, result, chalk.bold.green, triggeredBy);
        }
        this.updateMessage(routingMsg.id, { content: result, status: "done" });
        await this.handleAgentReply(result, label, triggeringMsgId, routingMsg.id, depth);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (streamBubble) {
          streamBubble.setFooter(`✗ ${message}`);
        } else {
          this.failLoader(spinner, `@${label} failed: ${message}`);
        }
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

    // Channel-native agents (standing channel agents, the orchestrator,
    // the workflow service) speak 47103 channel messages, not the 47001
    // task protocol — a task sent to one spins for the full timeout and
    // dies. Their supported_tasks say so; fail fast with the actual fix.
    const CHANNEL_NATIVE = new Set(["channel-chat", "orchestrate", "workflow-automation"]);
    if (target.supportedTasks.length > 0 && target.supportedTasks.every((t) => CHANNEL_NATIVE.has(t))) {
      this.failLoader(
        spinner,
        `@${target.name} lives in channels — join one you share (e.g. /join general) and mention it there.`
      );
      this.updateMessage(routingMsg.id, { content: "channel-native agent", status: "error" });
      return;
    }

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
    this.log.addChild(new Text(chalk.red("✗ ") + text, 0, 0));
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
   * One tg-shaped reply bubble. When triggeredBy is set (a chained reply),
   * the ✅ note rides the bubble footer — the visible form of the reaction
   * addReaction() recorded on the triggering message.
   */
  private printReply(
    displayName: string,
    content: string,
    _color: (s: string) => string,
    triggeredBy?: string
  ): void {
    const handle = this.appendBubble(`@${displayName}`, content);
    if (triggeredBy) handle.setFooter(`✅ responding to @${triggeredBy}`);
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

  /** Core chat messages ride the same tg-shaped bubble as extension messages. */
  private renderMessage(msg: Message): void {
    const name =
      msg.author === "user" ? "You" : msg.author === "orchestrator" ? "Fez" : `@${msg.author}`;
    this.appendBubble(name, msg.content);
  }

  /**
   * Chat bubble from an extension (ui.appendMessage) — tg/IRC-shaped:
   * `HH:MM:SS Author: message` on one line for short messages; longer or
   * multi-line content keeps the header line with markdown flowing below.
   * "You" gets the user's blue so an extension echoing the user's own
   * message matches native bubbles.
   *
   * Each bubble is its own nested Container, so the returned MessageHandle
   * can mutate it in place — live reaction rows, reply counts updating,
   * streamed content — in an otherwise append-only log. setContent
   * re-lays-out: a streaming reply can start as a one-liner and grow into
   * a header+block shape.
   */
  private appendBubble(
    author: string,
    content: string,
    ts?: number,
    position: "append" | "prepend" = "append",
    opts?: { linePrefix?: string; bare?: boolean }
  ): MessageHandle {
    if (!this.screen) {
      this.pendingBubbles.push({ author, content });
      // Pre-screen bubbles are startup notices — nothing updates them later.
      return { setAuthor: () => {}, setContent: () => {}, setFooter: () => {}, setMeta: () => {} };
    }
    // Historical bubbles (channel backfill, DM replay) carry the event's
    // real time; live ones stamp arrival. Older-than-today gets a date
    // prefix so a restart doesn't render last week as "just now".
    const when = ts ? new Date(ts * 1000) : new Date();
    const datePrefix =
      when.toDateString() === new Date().toDateString()
        ? ""
        : chalk.dim(when.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " ");
    const stamp = datePrefix + timestamp(when);
    let currentAuthor = author;
    let footerText = "";
    // Slack's hierarchy: AUTHOR then a small dim timestamp on the header
    // line, content on its own lines below — the name is the anchor the
    // eye scans, not an inline prefix competing with the text.
    const headText = () => authorColor(currentAuthor)(currentAuthor) + "  " + stamp;
    // Clickable per-message actions, rendered at the end of the first
    // line: ⧉ copies the message body to the clipboard, ↩ quotes it into
    // the editor. OSC-8 links routed by openUrl's fez-copy/fez-quote
    // branches; the registry tracks live content so streamed bubbles
    // copy their FINAL text.
    const actionId = String(++this.bubbleSeq);
    this.bubbleContents.set(actionId, content);
    if (this.bubbleContents.size > 300) {
      this.bubbleContents.delete(this.bubbleContents.keys().next().value as string);
    }
    const osc8 = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
    // HTML block model, Ken's spec: header block, full-width text block,
    // then ONE footer block per message — the action icons plus whatever
    // meta the owner attaches (reply count, /thread link via setMeta).
    // A single owned footer per message, not chrome scattered around it.
    let metaText = "";
    const actionsFooter = (hasCode: boolean) =>
      chalk.dim(
        [
          osc8(`fez-copy://${actionId}`, "⧉ copy"),
          ...(hasCode ? [osc8(`fez-copy://${actionId}.code`, "⧉ code")] : []),
          osc8(`fez-quote://${actionId}`, "↩ quote"),
        ].join("  ")
      ) + (metaText ? chalk.dim("  ·  ") + metaText : "");
    const bubble = new Container();
    const layout = (c: string) => {
      bubble.clear();
      this.bubbleContents.set(actionId, c);
      // Fenced code, extracted for the "⧉ code" action — streamed
      // updates keep this fresh so the final code is what copies.
      const codeBlocks = [...c.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\n$/, ""));
      if (codeBlocks.length > 0) this.bubbleContents.set(`${actionId}.code`, codeBlocks.join("\n\n"));
      if (opts?.bare) {
        // Bare: content only — no header, no timestamp, no actions. For
        // timeline chrome that is NAVIGATION, not conversation (thread
        // connector lines, beginning-of-channel markers): dressing those
        // as messages was why messages and threads read identically.
        if (!c.includes("\n") && c.length <= 160) bubble.addChild(new Text(c, 0, 0));
        else bubble.addChild(new Markdown(c, 0, 0, markdownTheme));
      } else if (currentAuthor === "You") {
        // pi's userMessageBg — on the TEXT block only: header and footer
        // sit outside the tint, so the highlight marks what you said,
        // not the chrome around it.
        bubble.addChild(new Text("\n" + headText(), 0, 0));
        bubble.addChild(new MentionColor(new Text(c, 1, 0, (s) => getActiveTheme().userMessageBg(s))));
        bubble.addChild(new Text(actionsFooter(codeBlocks.length > 0), 0, 0));
      } else {
        bubble.addChild(new Text("\n" + headText(), 0, 0));
        // Body indents two columns under the header — author names hang
        // at the margin, content forms its own edge: the left-to-right
        // hierarchy (who → what) the flat layout lacked.
        const body =
          !c.includes("\n") && c.length <= 100 ? new Text(c, 0, 0) : new Markdown(c, 0, 0, markdownTheme);
        // Two-tone timeline: their text on agentMessageBg, yours (above)
        // on userMessageBg — authorship readable from color alone.
        bubble.addChild(new BlockBg(new LinePrefix(new MentionColor(body), "  "), () => getActiveTheme().agentMessageBg));
        // Footer: directly below the text, flush at the margin like the
        // username — the dim styling alone marks it subordinate.
        bubble.addChild(new Text(actionsFooter(codeBlocks.length > 0), 0, 0));
      }
      // An empty Text still renders one blank line — only mount the footer
      // when it has content, or every message drags a stray gap under it.
      if (footerText) bubble.addChild(new Text(chalk.dim(footerText), 0, 0));
    };
    layout(content);
    // linePrefix (thread depth): the whole bubble renders narrowed and
    // prefixed per line — reddix's mechanism, with plain spaces.
    const mounted = opts?.linePrefix ? new LinePrefix(bubble, opts.linePrefix) : bubble;
    // Older-page loading inserts ABOVE the existing timeline — Container
    // children are a plain array, so prepend is an unshift.
    if (position === "prepend") this.log.children.unshift(mounted);
    else this.log.addChild(mounted);
    this.screen.requestRender();
    const rerender = () => this.screen.requestRender();

    // Typewriter tween: streamed sources (harness chunks, relay drafts)
    // arrive in coarse bursts, so snapping to each update reads as jumps,
    // not typing. setContent instead reveals toward the latest target at a
    // steady rate — the pi feel, independent of chunk granularity. Reveal
    // speed adapts so the animation never lags a fast stream unboundedly.
    let shown = content.length;
    let target = content;
    let tween: ReturnType<typeof setInterval> | undefined;
    const step = () => {
      if (shown >= target.length) {
        clearInterval(tween);
        tween = undefined;
        layout(target); // exact final text (mid-reveal can split ANSI/markdown)
        rerender();
        return;
      }
      shown = Math.min(target.length, shown + Math.max(3, Math.ceil((target.length - shown) / 12)));
      layout(target.slice(0, shown));
      rerender();
    };

    return {
      setAuthor: (a) => {
        currentAuthor = a;
        layout(shown >= target.length ? target : target.slice(0, shown));
        rerender();
      },
      setContent: (c) => {
        // Not an append-y update (edit/replace): snap, don't animate.
        if (!c.startsWith(target.slice(0, Math.min(shown, target.length)))) {
          clearInterval(tween);
          tween = undefined;
          shown = c.length;
          layout(c);
          rerender();
          target = c;
          return;
        }
        target = c;
        if (!tween) tween = setInterval(step, 33);
      },
      setMeta: (m) => {
        metaText = m;
        layout(shown >= target.length ? target : target.slice(0, shown));
        rerender();
      },
      setFooter: (f) => {
        footerText = f;
        layout(shown >= target.length ? target : target.slice(0, shown));
        rerender();
      },
    };
  }

  /** A dim one-liner outside the chat-bubble shape — startup notes, routing warnings. */
  private systemLine(text: string): void {
    this.log.addChild(new Text(chalk.dim(text), 0, 0));
    this.screen.requestRender();
  }

  /**
   * JSON themes — pi's themes-as-data model: ~/.fez/themes/*.json are
   * flat color-token files (hex / 256-index / "", optional vars),
   * compiled into theme specs and registered exactly like extension
   * packs. Data beats code here: schema-validatable, safely
   * agent-authorable, and a future GUI imports the same JSON directly.
   * Hot reload: editing the ACTIVE theme's file reapplies it on save.
   */
  private loadJsonThemes(): void {
    const dir = path.join(os.homedir(), ".fez", "themes");
    const register = (file: string): string | undefined => {
      try {
        const spec = JSON.parse(fsSync.readFileSync(path.join(dir, file), "utf-8")) as ThemeJson;
        const compiled = compileThemeJson(spec);
        registerThemePack(compiled as never);
        return compiled.name;
      } catch (err) {
        console.error(`⚠️  theme ${file}: ${err instanceof Error ? err.message : err}`);
        return undefined;
      }
    };
    let entries: string[] = [];
    try {
      entries = fsSync.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return; // no themes dir yet
    }
    for (const file of entries) register(file);
    try {
      const watcher = fsSync.watch(dir, (_event, file) => {
        if (!file || !file.endsWith(".json")) return;
        setTimeout(() => {
          const name = register(file);
          if (name && name === getActiveTheme().name) {
            const spec = findTheme(name);
            if (spec) {
              setActiveTheme(spec as unknown as Partial<FezTheme>);
              this.screen?.requestRender();
            }
          }
        }, 60); // editors fire rename+change pairs; a beat lets the write land
      });
      watcher.unref?.();
    } catch { /* watching is best-effort */ }
  }

  /**
   * Themes: packs registered during loadExtensions() and JSON themes
   * from ~/.fez/themes become switchable via /theme, the choice
   * persisted in ~/.fez/theme.json. Applying is a live swap — the theme
   * module's exports are delegates into the active theme, so everything
   * rendered from now on (and the sidebar, which repaints every frame)
   * picks it up; existing bubbles keep the colors they were painted
   * with.
   */
  private initThemes(): void {
    const prefFile = path.join(os.homedir(), ".fez", "theme.json");
    const apply = (name: string): boolean => {
      if (name === "fez" || name === "default") {
        setActiveTheme({ name: "fez" });
        return true;
      }
      const spec = findTheme(name);
      if (!spec) return false;
      setActiveTheme(spec as unknown as Partial<FezTheme>);
      return true;
    };

    try {
      const saved = JSON.parse(fsSync.readFileSync(prefFile, "utf-8")).name;
      if (typeof saved === "string" && !apply(saved)) {
        console.error(`⚠️  Saved theme "${saved}" isn't registered — using default. Reinstall its pack or /theme fez.`);
      }
    } catch { /* no saved preference */ }

    registerCommand("theme", (args, ctx) => {
      const name = args.trim();
      const names = ["fez", ...getRegisteredThemes().map((t) => t.name)];
      if (!name) {
        ctx.reply(
          `Themes: ${names.map((n) => (n === getActiveTheme().name ? `**${n}** ← active` : n)).join(" · ")}\n` +
            `Switch with /theme <name>. Packs are extensions calling api.registerTheme (see examples/themes/).`
        );
        return;
      }
      if (!apply(name)) {
        ctx.reply(`No theme "${name}". Available: ${names.join(", ")}`);
        return;
      }
      try {
        fsSync.mkdirSync(path.dirname(prefFile), { recursive: true });
        fsSync.writeFileSync(prefFile, JSON.stringify({ name: getActiveTheme().name }), { mode: 0o600 });
      } catch { /* preference persists best-effort */ }
      this.screen.requestRender();
      ctx.reply(`Theme → **${getActiveTheme().name}** — new output uses it (sidebar repaints immediately).`);
    });
  }

  /** Startup chrome, flow-title style: block logo + session info + hints — replaces both the old rule-banner and the welcome bubble. */
  private renderHeader(harnessLine: string): void {
    // The landing page's sigil, so the terminal and the site are
    // recognisably the same product. (Backslashes are doubled — this is
    // a TS string literal, not a heredoc.)
    const logo = [
      "   ______",
      "  / ____/___  ____",
      " / /_  / _ \\/_  /",
      "/ __/ /  __/ / /_",
      "/_/    \\___/ /___/",
    ].map((l) => getActiveTheme().banner(l));
    this.log.addChild(
      new Text(
        [
          "",
          ...logo,
          "",
          getActiveTheme().brand("fez") + chalk.dim(" · decentralized MCP for agents"),
          chalk.dim("relay:  ") + chalk.cyan(this.relayList().join(", ")),
          chalk.dim("you:    ") + chalk.cyan(this.myPubkey.slice(0, 16) + "…"),
          chalk.dim("agents: ") + harnessLine,
          "",
          chalk.dim("@name to talk to an agent · /join <channel> · /threads · /watch <agent> · /help · /quit"),
        ].join("\n"),
        0,
        0
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
