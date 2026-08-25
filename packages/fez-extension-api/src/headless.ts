import type { NostrAccess, ChannelsAccess, WorkspaceAccess, NostrEvent } from "./nostr.js";

/**
 * The HEADLESS surface — the API a `headless` part receives, running in
 * the TUI and the always-on sentinel (beside the user's key). This is
 * where an extension adds slash commands, scheduled work, and (in the
 * TUI) its own side panels and messages.
 *
 * Optionality is the contract: `nostr`, `channels`, `workspace`, and
 * `client` are present only where a key, a relay, or a running client
 * are. A command that needs them checks and degrades; it must never
 * assume. `ui` exists wherever a headless part runs, but a scheduled
 * task in the sentinel has no one to show a panel to — build for the
 * TUI and let the daemon ignore the view calls.
 */
export interface CommandContext {
  reply(content: string): void;
}

export interface ScheduledTaskContext {
  nostr: NostrAccess;
  /** The machine owner's pubkey — the authority a task acts on behalf of. */
  ownerPubkey: string;
  channels: ChannelsAccess;
  /** True when the clock jumped far past the interval (the machine slept) — a task may skip catch-up work. */
  missedWindow: boolean;
}

/** Claim raw composer input before it's sent — resolve true if handled. */
export type InputHandler = (text: string) => Promise<boolean>;
/** Claim clicks on OSC-8 links whose URL starts with a prefix. */
export type UrlHandler = (url: string) => void;

/**
 * Durable state for this extension — a namespaced store the host keeps
 * under ~/.fez/extension-data/ and drops on `fez remove`. Always
 * present, no permission required. Values are JSON.
 */
export interface StorageAccess {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** A side panel an extension owns in the TUI — set its text, it renders. */
export interface PanelHandle {
  setText(text: string): void;
}

/** A message bubble an extension appended — mutate its parts in place. */
export interface MessageHandle {
  setAuthor(author: string): void;
  setContent(content: string): void;
  setFooter(text: string): void;
  setMeta(text: string): void;
}

/**
 * Cross-extension view ownership: only one extension "owns" the main
 * timeline at a time, so a board view and the chat log don't fight over
 * the same rows. Claim it to take over, release to give it back.
 */
export interface ViewBus {
  owner(): string;
  claim(owner: string): void;
  release(): void;
  onChange(cb: (owner: string) => void): void;
}

/** The TUI's view surface — panels, messages, and the timeline it draws. */
export interface HeadlessUi {
  setStatus(key: string, value: string): void;
  createSidePanel(opts?: { width?: number; title?: string; icon?: string; order?: number }): PanelHandle;
  appendMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
  prependMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
  onLogScrollTop(handler: () => Promise<void>): void;
  notify(text: string): void;
  clearLog(): void;
  viewBus: ViewBus;
}

export interface FezExtensionAPI {
  /** Add a slash command: `/name …`. */
  registerCommand(name: string, handler: (args: string, ctx: CommandContext) => void | Promise<void>): void;
  /** Claim raw composer input before it's sent. */
  registerInputHandler(handler: InputHandler): void;
  /** Claim clicks on OSC-8 links whose URL starts with `prefix`. */
  registerUrlHandler(prefix: string, handler: UrlHandler): void;
  /**
   * Run `run` every `everyMs` in the always-on host (the sentinel).
   * Requires the `background` permission. Floored at 60s; a throw is
   * logged and retried next tick, never fatal. The foreground behavior
   * of the extension must never depend on this having run.
   */
  registerScheduledTask(name: string, everyMs: number, run: (ctx: ScheduledTaskContext) => void | Promise<void>): void;
  /** Durable per-extension state — always present, dropped on `fez remove`. */
  storage: StorageAccess;
  /** Present only where a key is (TUI, sentinel). */
  nostr?: NostrAccess;
  /** Present only where the workspace owner is known. */
  channels?: ChannelsAccess;
  /** Which relay this is and who owns it. */
  workspace?: WorkspaceAccess;
  /**
   * The process's shared @fezchat/client instance, headless — protocol
   * state and actions. Undefined outside the TUI. Typed as `unknown`
   * here so this package never pulls in the client; cast it to a
   * type-only `import type { FezClient } from "@fezchat/client"`.
   */
  client?: unknown;
  /** The TUI's view surface — panels, messages, timeline. */
  ui: HeadlessUi;
}

export type { NostrAccess, ChannelsAccess, WorkspaceAccess, NostrEvent };
