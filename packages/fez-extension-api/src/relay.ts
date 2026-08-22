import type { NostrEvent } from "./nostr.js";

/**
 * The RELAY surface — the API a `relay` part receives, loaded only by a
 * relay started with `--extensions`. This runs INSIDE the store process,
 * so it can serve HTTP and advertise itself, but it holds NO signing
 * key: a relay part can record and serve, never speak on the network.
 * Anything that must be said on the relay is said by the key-holding
 * side (the sentinel), reading what the relay served.
 */
export interface StoredEvent extends NostrEvent {
  sig: string;
}

export interface RelayHttpHandler {
  /** Return true if this request is yours (you answered it); false to fall through. */
  handle(req: unknown, res: unknown): boolean | Promise<boolean>;
}

export interface RelayExtensionAPI {
  /** Answer HTTP on the relay's port. First handler to claim a request owns it; unclaimed falls through to NIP-11. */
  registerHttpHandler(handler: RelayHttpHandler): void;
  /** Read stored events — how a relay part authorizes against facts the workspace already signed (roster, bans). */
  query(filter: Record<string, unknown>): StoredEvent[];
  /** A directory this extension may keep bytes in (bare repos, caches). */
  dataDir(name: string): string;
  /** Describe what you added in the relay's NIP-11 document. Namespace the key by package (`fez_git`, not `git`). */
  advertise(key: string, value: unknown): void;
  /** Public origins this relay answers to — for anything verifying signed URLs (NIP-98). */
  origins: readonly string[];
  /** The workspace owner's pubkey from NIP-11. Undefined = unclaimed. */
  owner?: string;
  log(line: string): void;
}
