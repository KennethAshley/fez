/**
 * Which chains exist, and how to name one.
 *
 * Deliberately free of node imports: `config.ts` (node) and `gui.ts` (a
 * browser bundle) both need this mapping, and the panel showing a different
 * chain than the wallet dials is exactly the divergence the network guard
 * exists to prevent. One home, so they cannot drift.
 */

export type Network = "test" | "finney";

export const NETWORKS: Network[] = ["test", "finney"];

const ENDPOINTS: Record<Network, string> = {
  finney: "wss://entrypoint-finney.opentensor.ai:443",
  test: "wss://test.finney.opentensor.ai:443",
};

export function endpointFor(network: Network): string {
  return ENDPOINTS[network];
}

/** Like endpointFor, but honest about a network it does not know — prefs is
 * a file and can hold a hand-edit or a value from a newer build. */
export function endpointForUnchecked(network: string): string | undefined {
  return (ENDPOINTS as Record<string, string>)[network];
}

/**
 * A recognised network endpoint is network-owned, never a user override:
 * whoever wrote it was naming a network, and the network's own home is prefs.
 * Only an endpoint no network maps to — a local node, a fork — is a genuine
 * override.
 */
export function isNetworkOwnedEndpoint(url: string | undefined): boolean {
  return url !== undefined && (Object.values(ENDPOINTS) as string[]).includes(url);
}

/**
 * Which network does this URL name? The reverse of endpointFor. A wallet
 * written before prefs existed recorded its network ONLY as a pinned
 * endpoint, so that pin is the sole surviving record of the owner's intent.
 */
export function networkFromEndpoint(url: string | undefined): Network | undefined {
  return (Object.entries(ENDPOINTS) as [Network, string][]).find(([, u]) => u === url)?.[0];
}
