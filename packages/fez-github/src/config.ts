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
  /** Repos being watched — a channel each. */
  repos: string[];
  /** Floor of 60s — this spends someone else's API quota. */
  pollSeconds?: number;
  /** Who we connected as. Public, and only ever decoration. */
  login?: string;
  /**
   * Every repo the App is installed on, cached by the poller.
   *
   * The panel cannot ask GitHub itself: the webview holds a token only
   * during connect, because the keychain has no read path back into it
   * (set_skill_secret exists, read_skill_secret does not, deliberately).
   * So the half that HAS the token writes down what it can see, and the
   * half that draws the picker reads that.
   */
  available?: { repo: string; private: boolean }[];
  /**
   * Repos whose new items get routed to an agent, by name.
   *
   * Opt-in per repo because it spends money: every new issue or pull
   * request costs an orchestrator turn plus whatever the agent it picks
   * then does. On a busy public repo that is a bill and an attack
   * surface — anyone can open an issue — so it is never on by default,
   * and a repo you removed stays removed.
   */
  triage?: string[];
}

export const EMPTY: Config = { repos: [] };

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((r): r is string => typeof r === "string") : [];

/** Drop anything that isn't shaped like config, whatever the relay handed us. */
export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object") return EMPTY;
  const value = raw as Record<string, unknown>;
  const config: Config = { repos: strings(value.repos) };
  if (typeof value.pollSeconds === "number" && Number.isFinite(value.pollSeconds)) {
    config.pollSeconds = value.pollSeconds;
  }
  if (typeof value.login === "string" && value.login) config.login = value.login;
  if (Array.isArray(value.available)) {
    const available = value.available
      .filter((row): row is { repo: string; private?: unknown } => !!row && typeof row === "object" && typeof (row as { repo?: unknown }).repo === "string")
      .map((row) => ({ repo: row.repo, private: row.private === true }));
    if (available.length > 0) config.available = available;
  }
  // Only ever a subset of what is watched: triage on a repo the bridge
  // no longer polls would be a standing instruction nothing enforces.
  const triage = strings(value.triage).filter((repo) => config.repos.includes(repo));
  if (triage.length > 0) config.triage = triage;
  return config;
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
