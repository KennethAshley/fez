import { RelayConnection, KIND_CHANNEL, loadOrCreateKey } from "@fezchat/protocol";

/**
 * Shared plumbing for standing services (channel-agent, indexer): stable
 * per-service identity and channel-spec resolution. Both run via `fez run`
 * with @fezchat/protocol external — see channel-agent.ts's header for the
 * custody rationale (a service must not inherit the user's key).
 */

/** Stable service identity "agent:<name>" — core custody (keychain on macOS, migrates legacy ~/.fez/agents/<name>.key). */
export function loadServiceKey(name: string): string {
  return loadOrCreateKey(`agent:${name}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve channel specs to ids. UUIDs pass through; anything else is a
 * channel NAME, matched (case-insensitive, optional leading #) against
 * 47101 channel-metadata events on the relay — raw channel UUIDs proved
 * to be a recurring foot-gun (relay resets mint new ids, services end up
 * pointed at dead channels). A name may match several channels across
 * communities; the service serves all of them. Exits the process when
 * nothing resolves — a service with no channels is a misconfiguration.
 */
export async function resolveChannels(relay: RelayConnection, specs: string[], relayUrl: string): Promise<string[]> {
  const channels: string[] = specs.filter((s) => UUID_RE.test(s));
  const nameSpecs = specs.filter((s) => !UUID_RE.test(s));
  if (nameSpecs.length > 0) {
    const channelEvents = await relay.query([{ kinds: [KIND_CHANNEL] }]);
    for (const spec of nameSpecs) {
      const wanted = spec.replace(/^#/, "").toLowerCase();
      const ids = channelEvents
        .filter((e) => {
          // An exact d-tag match IS the channel — fixed ids exist now
          // (bootstrap-general), and the UUID test above no longer
          // implies "everything else is a name".
          if (e.tags.some((t) => t[0] === "d" && t[1] === spec)) return true;
          try {
            return (JSON.parse(e.content).name ?? "").toLowerCase() === wanted;
          } catch {
            return false;
          }
        })
        .map((e) => e.tags.find((t) => t[0] === "d")?.[1])
        .filter((id): id is string => !!id);
      if (ids.length === 0) {
        console.warn(`⚠️  No channel named "${spec}" found on ${relayUrl}`);
      } else {
        console.log(`🔎 "${spec}" → ${ids.length} channel(s): ${ids.join(", ")}`);
        channels.push(...ids);
      }
    }
  }
  if (channels.length === 0) {
    console.error("No channels resolved — check the channel list and the relay.");
    process.exit(1);
  }
  return channels;
}

/** Buzz's NIP-10 parse: parent = last reply-marked e-tag; root = root-marked ?? parent. */
export function parseThreadRef(tags: string[][]): { parentId?: string; rootId?: string } {
  const parentId = tags.filter((t) => t[0] === "e" && t[3] === "reply").at(-1)?.[1];
  const rootId = tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? parentId;
  return { parentId, rootId };
}
