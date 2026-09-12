/**
 * The event shapes an extension sees. Structural on purpose — an
 * extension never imports nostr-tools; it receives already-parsed
 * events and templates. Matches the wire (a NIP-01 event minus the
 * fields the host fills: id and sig are present on what you receive,
 * absent from what you publish).
 */
export interface NostrEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  sig?: string;
}

/** A subscription/query filter — the NIP-01 filter object. */
export type NostrFilter = Record<string, unknown>;

/**
 * The relay, as the user. Publishing SIGNS with the user's key, so a
 * host gates it behind the `publish` permission. Present only where a
 * key is (the TUI and the sentinel), undefined elsewhere.
 * Denied operations throw (synchronous methods) or reject (Promise
 * methods), naming the extension, operation, and required permission.
 * An empty result never stands in for a permission denial.
 */
export interface NostrAccess {
  pubkey: string;
  /** Preserve the prepared timestamp on an idempotent publish retry. */
  publish(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<NostrEvent>;
  /** Sign WITHOUT publishing — NIP-98 HTTP auth headers. The key stays behind the seam. */
  signEvent(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): NostrEvent & { sig: string };
  subscribe(filters: NostrFilter[], onEvent: (event: NostrEvent) => void): () => void;
  query(filters: NostrFilter[]): Promise<NostrEvent[]>;
  queryWithStatus?(filters: NostrFilter[]): Promise<{ events: NostrEvent[]; failures: { url: string; reason: string }[] }>;
  /** NIP-44 with the user's key. */
  encrypt(peerPubkey: string, plaintext: string): string;
  decrypt(peerPubkey: string, ciphertext: string): string;
}

/** A channel reference the host has resolved. */
export interface ChannelRef {
  id: string;
  name: string;
  source?: string;
  meta?: Record<string, string>;
  archived?: boolean;
  visibility?: "open" | "closed";
}

/**
 * Open channels and post in them without knowing the wire. Only the
 * workspace OWNER may sign a channel into being, so `ensure` returns
 * undefined for anyone else. Undefined on an unclaimed relay.
 */
export interface ChannelsAccess {
  list(): Promise<ChannelRef[]>;
  ensure(spec: { name: string; source?: string; meta?: Record<string, string>; visibility?: "open" | "closed" }): Promise<string | undefined>;
  say(channelId: string, text: string, opts?: { threadRoot?: string }): Promise<string>;
}

/** What the relay says it is — its NIP-11 document, including what its relay extensions advertised. */
export interface WorkspaceAccess {
  relayUrl?: string;
  /** Owner pubkey from NIP-11. Undefined = unclaimed. */
  owner?: string;
  info?: Record<string, unknown>;
}
