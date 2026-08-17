/**
 * Structural mirror of fez's FezExtensionAPI (src/extensions.ts) — the
 * slice this extension uses. Type-only, erased at bundle time, so the
 * installed single-file bundle has zero imports (see the other
 * extensions' api-types for the rationale). TypeScript's structural
 * typing keeps it honest against the real API.
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
  subscribe(filters: NostrFilter[], onEvent: (event: NostrEvent) => void): () => void;
  query(filters: NostrFilter[]): Promise<NostrEvent[]>;
  decrypt(peerPubkey: string, ciphertext: string): string;
  unwrapDm(event: NostrEvent): DmRumor | undefined;
}

export interface CommandContext {
  reply(content: string): void;
}

export interface FezExtensionAPI {
  registerCommand(name: string, handler: (args: string, ctx: CommandContext) => void | Promise<void>): void;
  nostr?: NostrAccess;
  ui: {
    notify(text: string): void;
  };
}
