import type { Filter } from "nostr-tools";
import type { SignedNostrEvent } from "./consent.js";
import type { Network } from "./storage-mirror.js";
import { parseAddressEvent, addressFilter } from "./address-event.js";

/**
 * `to` is tried in order and falls through to today's behaviour. The
 * fall-through is load-bearing: a name this resolver does not recognise
 * goes to the chain verbatim, so paying something fez has never
 * integrated stays possible. This adds names; it never removes the raw
 * path. The only gates on a send are the amount threshold and the
 * new-payee card — never identity.
 */
export interface Resolved {
  address: string;
  /** Present only when the payee announced one — a raw address has none. */
  network?: Network;
  via: "local" | "agent" | "raw";
  /** Only set on the "agent" branch — the roster member's pubkey. A name
   * is not an identity (two owners can both run a "chip"); the pubkey is
   * what a receipt p-tags and a new-payee consent card keys on. */
  payeePubkey?: string;
}

export interface ResolveDeps {
  chain: string;
  network: Network;
  roster(): Promise<{ name: string; pubkey: string }[]>;
  addressEvents(filter: Filter): Promise<SignedNostrEvent[]>;
  localAddress(name: string): string | undefined;
}

export async function resolveRecipient(to: string, deps: ResolveDeps): Promise<Resolved> {
  const name = to.startsWith("@") ? to.slice(1) : to;

  const local = deps.localAddress(name);
  if (local) return { address: local, via: "local" };

  const matches = (await deps.roster()).filter((m) => m.name === name);
  if (matches.length > 1) {
    // A name is not an identity — the npub is. Two owners may both run a
    // "chip", and picking one would be picking whose money moves.
    throw new Error(
      `"${name}" matches more than one agent here (${matches
        .map((m) => m.pubkey.slice(0, 12) + "…")
        .join(", ")}) — send to the address instead`
    );
  }
  if (matches.length === 1) {
    const events = await deps.addressEvents(addressFilter([matches[0].pubkey], deps.chain, deps.network));
    const parsed = events.map(parseAddressEvent).find(Boolean);
    if (!parsed) {
      throw new Error(`${name} hasn't published a ${deps.chain.toUpperCase()} address`);
    }
    return { address: parsed.address, network: parsed.network, via: "agent", payeePubkey: matches[0].pubkey };
  }

  return { address: to, via: "raw" };
}
