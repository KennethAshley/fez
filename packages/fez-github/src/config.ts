import type { NostrAccess, NostrEvent } from "./api-types.js";

/**
 * Which repos to watch — on the relay, encrypted to yourself.
 *
 * It began as ~/.fez/github.json, which meant configuring this extension
 * was four hand-edits in a dotfile and the GUI could not touch it at all:
 * a GUI extension runs in the webview, with no filesystem and no
 * subprocess. Putting config where the webview already reaches makes it
 * editable, and syncs it across your machines for nothing.
 *
 * NIP-78 (`kind:30078`) is the standard for application data and is
 * parameterized-replaceable, so there is exactly one config event and
 * editing replaces it. fez already publishes read state on this kind,
 * keyed by channel UUID — the `ext:` prefix keeps an extension's `d` tag
 * from ever colliding with one.
 *
 * SELF-ENCRYPTED, and not as ceremony. A repo list is the one part of
 * this that names things: `owner/private-thing` is a disclosure even to
 * someone who cannot read the repo, and workspace members can read the
 * relay. Encrypting to your own key keeps the config yours while it
 * still lives somewhere every one of your clients can get at.
 *
 * The rule this follows, for whatever needs config next: put it on the
 * relay if you would say it out loud in the channel, self-encrypt it if
 * you would not — and never put a secret in either. Tokens stay in the
 * keychain.
 */

/** NIP-78 application data. */
const KIND_APP_DATA = 30078;

/** Namespaced so an extension's config can never look like a channel's read state. */
export const CONFIG_D = "ext:fez-github";

export interface Config {
  repos: string[];
  /** Floor of 60s — this spends someone else's API quota. */
  pollSeconds?: number;
}

export const EMPTY: Config = { repos: [] };

/** Drop anything that isn't shaped like config, whatever the relay handed us. */
export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object") return EMPTY;
  const value = raw as { repos?: unknown; pollSeconds?: unknown };
  const repos = Array.isArray(value.repos) ? value.repos.filter((r): r is string => typeof r === "string") : [];
  const pollSeconds = typeof value.pollSeconds === "number" && Number.isFinite(value.pollSeconds) ? value.pollSeconds : undefined;
  return pollSeconds === undefined ? { repos } : { repos, pollSeconds };
}

export async function loadConfig(nostr: NostrAccess, owner: string): Promise<Config> {
  let events: NostrEvent[];
  try {
    events = (await nostr.query([
      { kinds: [KIND_APP_DATA], authors: [owner], "#d": [CONFIG_D], limit: 5 },
    ])) as NostrEvent[];
  } catch {
    return EMPTY; // relay unreachable — watch nothing rather than guess
  }
  // Newest wins. A replaceable kind SHOULD leave one, but a relay that
  // kept two must not be resolved by whichever arrived first.
  const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!newest) return EMPTY;
  try {
    return parseConfig(JSON.parse(nostr.decrypt(owner, newest.content)));
  } catch {
    // Wrong key or garbage. Returning EMPTY would look identical to
    // "not configured" and would silently stop the bridge, so say so.
    console.warn("⚠️  fez-github: found a config event but could not read it — is this the machine that wrote it?");
    return EMPTY;
  }
}

export async function saveConfig(nostr: NostrAccess, config: Config): Promise<void> {
  await nostr.publish({
    kind: KIND_APP_DATA,
    tags: [["d", CONFIG_D]],
    content: nostr.encrypt(nostr.pubkey, JSON.stringify(config)),
  });
}
