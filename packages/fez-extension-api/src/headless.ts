import type { NostrAccess, ChannelsAccess, WorkspaceAccess, NostrEvent } from "./nostr.js";

/**
 * The HEADLESS surface — the API a `headless` part receives, running in
 * the TUI and the always-on sentinel (beside the user's key). This is
 * where an extension adds slash commands and scheduled work.
 *
 * Optionality is the contract: `nostr`, `channels`, and `workspace` are
 * present only where a key and a relay are. A command that needs them
 * checks and degrades; it must never assume.
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

export interface FezExtensionAPI {
  /** Add a slash command: `/name …`. */
  registerCommand(name: string, handler: (args: string, ctx: CommandContext) => void | Promise<void>): void;
  /**
   * Run `run` every `everyMs` in the always-on host (the sentinel).
   * Requires the `background` permission. Floored at 60s; a throw is
   * logged and retried next tick, never fatal. The foreground behavior
   * of the extension must never depend on this having run.
   */
  registerScheduledTask(name: string, everyMs: number, run: (ctx: ScheduledTaskContext) => void | Promise<void>): void;
  /** Present only where a key is (TUI, sentinel). */
  nostr?: NostrAccess;
  /** Present only where the workspace owner is known. */
  channels?: ChannelsAccess;
  /** Which relay this is and who owns it. */
  workspace?: WorkspaceAccess;
}

export type { NostrAccess, ChannelsAccess, WorkspaceAccess, NostrEvent };
