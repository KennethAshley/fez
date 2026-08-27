import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import type { Filter } from "nostr-tools";
import type { SignedNostrEvent } from "./consent.js";
import type { Network } from "./storage-mirror.js";
import { NETWORKS } from "./networks.js";

/**
 * Where an agent can be paid. Signed by the AGENT's own nostr key —
 * fez-acp owns the 47000 announce and cannot read the wallet keychain,
 * so this is the wallet's own event rather than a field on that one.
 *
 * Addressable (30000–39999 per NIP-01): the useful query is "the current
 * address for this agent on this chain and network", so it self-replaces.
 */
export const KIND_AGENT_PAYMENT_ADDRESS = 30175;

const KNOWN = new Set<Network>(NETWORKS);

export function buildAddressEvent(opts: {
  agentSecretHex: string;
  chain: string;
  network: Network;
  address: string;
}): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: KIND_AGENT_PAYMENT_ADDRESS,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", `${opts.chain}:${opts.network}`],
        ["chain", opts.chain],
        ["network", opts.network],
      ],
      content: opts.address,
    },
    hexToBytes(opts.agentSecretHex)
  );
}

export function parseAddressEvent(
  ev: SignedNostrEvent
): { chain: string; network: Network; address: string } | undefined {
  if (ev.kind !== KIND_AGENT_PAYMENT_ADDRESS) return undefined;
  const tag = (k: string) => ev.tags.find((t) => t[0] === k)?.[1];
  const chain = tag("chain");
  const network = tag("network") as Network | undefined;
  const address = ev.content.trim();
  // An unknown network is refused rather than defaulted: defaulting here
  // would be the one place a mainnet address could pass as a testnet one.
  if (!chain || !network || !KNOWN.has(network) || !address) return undefined;
  return { chain, network, address };
}

export function addressFilter(pubkeys: string[], chain: string, network: Network): Filter {
  return {
    kinds: [KIND_AGENT_PAYMENT_ADDRESS],
    authors: pubkeys,
    "#d": [`${chain}:${network}`],
  };
}
