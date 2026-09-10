import { decode, npubEncode } from "nostr-tools/nip19";

const isHexKey = (value: string) => value.length === 64 && /^[0-9a-f]{64}$/i.test(value);
export const isNostrKeyInput = (value: string): boolean => /^(?:npub|nsec)1/i.test(value.trim());

/** Abbreviations and malformed keys must never become shareable identities. */
export function npubForPubkey(pk: string): string | undefined {
  return isHexKey(pk) ? npubEncode(pk.toLowerCase()) : undefined;
}

/** User-facing npubs are decoded before reaching the hex-only client APIs. */
export function pubkeyFromInput(raw: string): string | undefined {
  const value = raw.trim();
  if (isHexKey(value)) return value.toLowerCase();
  if (!/^npub1/i.test(value)) return undefined;
  try {
    const decoded = decode(value);
    return decoded.type === "npub" && isHexKey(decoded.data) ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** A rejected identity must not fall through to an unrelated person's name. */
export function resolvePubkeyInput(raw: string, byName: (name: string) => string | undefined): string | undefined {
  const pk = pubkeyFromInput(raw);
  if (pk) return pk;
  if (isNostrKeyInput(raw)) throw new Error("Invalid public key — use a valid npub or hex key");
  return byName(raw);
}
