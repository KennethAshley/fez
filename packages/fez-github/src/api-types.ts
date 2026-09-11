/**
 * Structural mirror of fez's FezExtensionAPI (src/extensions.ts) — the
 * slice this extension uses. Type-only, erased at bundle time; the
 * bundled file has zero imports. TypeScript's structural typing keeps
 * this honest against the real API.
 */

export interface NostrEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

export interface PanelHandle {
  setText(text: string): void;
}

export interface MessageHandle {
  setAuthor(author: string): void;
  setContent(content: string): void;
  setFooter(text: string): void;
  setMeta(text: string): void;
}

export interface ViewBus {
  owner(): string;
  claim(owner: string): void;
  release(): void;
  onChange(cb: (owner: string) => void): void;
}

export interface CommandContext {
  reply(content: string): void;
}

/**
 * What a scheduled task gets. Note there is no `client` here: that is a
 * TUI-only convenience, and the sentinel — where background work
 * actually runs — has none. Anything a task publishes, it builds.
 */
export interface NostrAccess {
  pubkey: string;
  publish(tmpl: { kind: number; tags: string[][]; content: string }): Promise<NostrEvent>;
  query(filters: Record<string, unknown>[]): Promise<NostrEvent[]>;
  /** Live events. Returns its own unsubscribe. */
  subscribe(filters: Record<string, unknown>[], onEvent: (event: NostrEvent) => void): () => void;
  /** NIP-44 with the user's key. Encrypting to your OWN pubkey is the self-encrypt path. */
  encrypt(peerPubkey: string, plaintext: string): string;
  /** Throws on wrong key/garbage — callers decide whether that's ignorable. */
  decrypt(peerPubkey: string, ciphertext: string): string;
}

/**
 * Channels without the wire — mirrors core's src/channels.ts.
 *
 * This extension used to carry its own copies of KIND_CHANNEL and
 * KIND_MESSAGE and build fez's threading tags by hand, because there
 * was nothing else on offer. There is now, and this is the shape of it.
 */
export interface ChannelsAccess {
  list(): Promise<{ id: string; name: string; source?: string; meta?: Record<string, string> }[]>;
  /** Find by name or open it. Undefined when this key may not create channels. */
  ensure(spec: {
    name: string;
    source?: string;
    meta?: Record<string, string>;
    visibility?: "open" | "closed";
  }): Promise<string | undefined>;
  /** Returns the message id — the handle a thread hangs off. */
  say(channelId: string, text: string, opts?: { threadRoot?: string }): Promise<string>;
}

export interface ScheduledTaskContext {
  nostr: NostrAccess;
  ownerPubkey: string;
  channels: ChannelsAccess;
  /** True when the machine slept through intervals — catch up ONCE, never replay. */
  missedWindow: boolean;
}

export interface FezExtensionAPI {
  registerCommand(name: string, handler: (args: string, ctx: CommandContext) => void | Promise<void>): void;
  /** Needs the "background" permission — the poll loop. */
  registerScheduledTask(name: string, everyMs: number, run: (ctx: ScheduledTaskContext) => void | Promise<void>): void;
  registerInputHandler(handler: (text: string) => Promise<boolean>): void;
  registerUrlHandler(prefix: string, handler: (url: string) => void): void;
  /** The process's shared @fezchat/client instance — typed via a type-only import of @fezchat/client. */
  client?: unknown;
  /** Gated by permissions; undefined when the host offers none. */
  nostr?: NostrAccess;
  channels?: ChannelsAccess;
  ui: {
    setStatus(key: string, value: string): void;
    createSidePanel(opts?: { width?: number; title?: string; icon?: string; order?: number }): PanelHandle;
    appendMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
    prependMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
    onLogScrollTop(handler: () => Promise<void>): void;
    notify(text: string): void;
    clearLog(): void;
    viewBus: ViewBus;
  };
}
