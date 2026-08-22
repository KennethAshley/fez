/**
 * Structural mirror of the slice of FezExtensionAPI this package uses.
 * Type-only, erased at bundle time — the same arrangement fez-github has,
 * for the same reason: an installed extension is one bundled file with no
 * reachable node_modules, so it cannot import fez's internals.
 */

export interface NostrEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
}

export interface NostrAccess {
  pubkey: string;
  publish(tmpl: { kind: number; tags: string[][]; content: string }): Promise<NostrEvent>;
  /** Sign WITHOUT publishing — NIP-98 HTTP auth headers. The key stays behind the seam. */
  signEvent(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): NostrEvent & { sig: string };
  query(filters: Record<string, unknown>[]): Promise<NostrEvent[]>;
  subscribe(filters: Record<string, unknown>[], onEvent: (event: NostrEvent) => void): () => void;
  encrypt(peerPubkey: string, plaintext: string): string;
  decrypt(peerPubkey: string, ciphertext: string): string;
}

/** Channels without the wire — mirrors core's src/channels.ts. */
export interface ChannelsAccess {
  list(): Promise<{ id: string; name: string; source?: string; meta?: Record<string, string> }[]>;
  ensure(spec: {
    name: string;
    source?: string;
    meta?: Record<string, string>;
    visibility?: "open" | "closed";
  }): Promise<string | undefined>;
  say(channelId: string, text: string, opts?: { threadRoot?: string }): Promise<string>;
}

/** What the relay says it is — mirrors core's WorkspaceAccess. */
export interface WorkspaceAccess {
  relayUrl?: string;
  /** Owner pubkey from NIP-11. Undefined = unclaimed workspace. */
  owner?: string;
  /** The NIP-11 document, including fields its relay extensions advertised. */
  info?: Record<string, unknown>;
}

export interface ScheduledTaskContext {
  nostr: NostrAccess;
  ownerPubkey: string;
  channels: ChannelsAccess;
  missedWindow: boolean;
}

export interface CommandContext {
  reply(content: string): void;
}

export interface FezExtensionAPI {
  registerCommand(name: string, handler: (args: string, ctx: CommandContext) => void | Promise<void>): void;
  registerScheduledTask(name: string, everyMs: number, run: (ctx: ScheduledTaskContext) => void | Promise<void>): void;
  nostr?: NostrAccess;
  /** Undefined when the workspace owner is unknown — nobody can sign a channel then. */
  channels?: ChannelsAccess;
  workspace?: WorkspaceAccess;
}
