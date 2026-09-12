/**
 * NIP-11 — the relay's information document, which under the flat model
 * is the workspace's identity card.
 *
 * This is discovery metadata, not an ownership certificate. Consumers
 * reconcile the advertised key with their persistent owner pin before
 * trusting governed events. Legacy first use trusts discovery; an invite
 * or explicit expected key can establish trust independently of the relay.
 */

export interface RelayInfo {
  name?: string;
  description?: string;
  /** The workspace owner (NIP-11's administrative-contact pubkey). */
  pubkey?: string;
  contact?: string;
  icon?: string;
  supported_nips?: number[];
  software?: string;
  /**
   * Whatever relay extensions advertised, namespaced by package
   * (`fez_git`, not `git`).
   *
   * Open on purpose. `RelayExtensionAPI.advertise` exists so an
   * extension serving something over HTTP can say WHERE it is, and a
   * closed interface here deleted those fields at the type level while
   * the bytes sat in the response — so every client reconstructed the
   * URL from the websocket address instead, which is right on a laptop
   * and silently wrong behind a proxy.
   */
  [advertised: string]: unknown;
}

/** ws:// → http://, wss:// → https:// — NIP-11 rides the same origin. */
export function httpFromRelay(relay: string): string {
  return relay.trim().replace(/^ws:\/\//i, "http://").replace(/^wss:\/\//i, "https://").replace(/\/+$/, "");
}

/**
 * Fetch a relay's NIP-11 document. Resolves undefined rather than
 * throwing on any failure. Missing discovery does not erase an existing
 * owner pin; callers resolve authority separately from this metadata.
 */
export async function fetchRelayInfo(relay: string, timeoutMs = 5000): Promise<RelayInfo | undefined> {
  const url = httpFromRelay(relay);
  if (!/^https?:\/\//i.test(url)) return undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/nostr+json" },
      signal: abort.signal,
    });
    if (!res.ok) return undefined;
    const info = (await res.json()) as RelayInfo;
    // A malformed owner is worse than none: it would silently reject
    // every event from the real owner. Refuse to report it.
    if (info.pubkey && !/^[0-9a-f]{64}$/i.test(info.pubkey)) {
      return { ...info, pubkey: undefined };
    }
    return info;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
