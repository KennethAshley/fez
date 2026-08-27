import type { SignedNostrEvent } from "./consent.js";
import type { Network } from "./storage-mirror.js";
import { buildAddressEvent } from "./address-event.js";

/**
 * "Here is where you can pay me", published at most once per
 * chain+network per process.
 *
 * The guard is keyed by the event's `d` value, NOT by a bare boolean:
 * the address event is addressable and self-replaces per
 * `<chain>:<network>`, so a process that flips network mid-life has a
 * second announce to make. A boolean guard would let the stale
 * `tao:<old network>` event stand as the only thing on the relay, and
 * resolution on the new network would fail until restart.
 *
 * Failure is silent by design — an agent that cannot announce where to
 * be paid must still be able to pay — and a failed attempt still burns
 * the key: announcing is best-effort, never a retry loop in the hot
 * path of a tool call.
 */
export function createAddressAnnouncer(): (a: {
  agentSecretHex: string;
  chain: string;
  network: Network;
  address: string;
  publish: (ev: SignedNostrEvent) => Promise<void>;
}) => Promise<boolean> {
  const announced = new Set<string>();
  return async (a) => {
    const key = `${a.chain}:${a.network}`;
    if (announced.has(key)) return false;
    announced.add(key);
    try {
      await a.publish(
        buildAddressEvent({
          agentSecretHex: a.agentSecretHex,
          chain: a.chain,
          network: a.network,
          address: a.address,
        })
      );
      return true;
    } catch {
      return false;
    }
  };
}
