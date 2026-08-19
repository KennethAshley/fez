/**
 * NIP-11 — the relay's information document, which under the flat model
 * is the workspace's identity card.
 *
 * A relay IS a workspace, so this is where it says what it is called and
 * — the load-bearing part — which pubkey **owns** it. Only that key's
 * channel, roster and ban events count, so a client must read this
 * before it trusts anything governed.
 *
 * The relay naming its own owner is not the relay being trusted: lying
 * only makes its own events be ignored by anyone who knows better, and
 * the owner key stays portable across hosts. That is the difference
 * between this and Buzz, where the relay signs the roster itself.
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
}

/** ws:// → http://, wss:// → https:// — NIP-11 rides the same origin. */
export function httpFromRelay(relay: string): string {
  return relay.trim().replace(/^ws:\/\//i, "http://").replace(/^wss:\/\//i, "https://").replace(/\/+$/, "");
}

/**
 * Fetch a relay's NIP-11 document. Resolves undefined rather than
 * throwing on any failure: an unreachable or NIP-11-less relay is an
 * unclaimed workspace, which the caller already has to handle, and a
 * network error must not be the difference between "no owner" and a
 * crash on startup.
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
