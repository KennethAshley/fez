/**
 * Structural mirror of fez's FezExtensionAPI (src/extensions.ts) — type-only,
 * erased at bundle time. Declared locally so the built dist/index.js has
 * zero imports: an installed entry is a single file in ~/.fez/extensions/
 * with no reachable node_modules, so even a type-only dependency on
 * @fez/protocol would complicate the build for no runtime benefit.
 * TypeScript's structural typing keeps this honest against the real API.
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

export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}

export interface DmRumor {
  senderPk: string;
  peerPk: string;
  text: string;
  ts: number;
  depth: number;
  id: string;
}

export interface NostrAccess {
  pubkey: string;
  publish(tmpl: { kind: number; tags: string[][]; content: string }): Promise<NostrEvent>;
  subscribe(filters: NostrFilter[], onEvent: (event: NostrEvent) => void): () => void;
  query(filters: NostrFilter[]): Promise<NostrEvent[]>;
  encrypt(peerPubkey: string, plaintext: string): string;
  decrypt(peerPubkey: string, ciphertext: string): string;
  sendDm(recipientPubkey: string, text: string): Promise<string>;
  unwrapDm(event: NostrEvent): DmRumor | undefined;
}

export interface PanelHandle {
  setText(text: string): void;
}

export interface MessageHandle {
  setAuthor(author: string): void;
  setContent(content: string): void;
  setFooter(text: string): void;
}

export interface CommandContext {
  reply(content: string): void;
}

export interface FezExtensionAPI {
  registerCommand(name: string, handler: (args: string, ctx: CommandContext) => void | Promise<void>): void;
  registerInputHandler(handler: (text: string) => Promise<boolean>): void;
  registerUrlHandler(prefix: string, handler: (url: string) => void): void;
  nostr?: NostrAccess;
  ui: {
    setStatus(key: string, value: string): void;
    createSidePanel(opts?: { width?: number; title?: string; icon?: string; order?: number }): PanelHandle;
    appendMessage(author: string, content: string, ts?: number): MessageHandle;
    notify(text: string): void;
    clearLog(): void;
  };
}
