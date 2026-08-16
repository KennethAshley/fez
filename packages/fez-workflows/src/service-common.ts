import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { RelayConnection, KIND_CHANNEL } from "@fez/protocol";

/**
 * Shared plumbing for standing services (channel-agent, indexer): stable
 * per-service identity and channel-spec resolution. Both run via `fez run`
 * with @fez/protocol external — see channel-agent.ts's header for the
 * custody rationale (a service must not inherit the user's key).
 */

/** Load or create a stable key at ~/.fez/agents/<name>.key (0o600). */
export function loadServiceKey(name: string): string {
  const keyPath = path.join(os.homedir(), ".fez", "agents", `${name}.key`);
  try {
    return fs.readFileSync(keyPath, "utf-8").trim();
  } catch {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    console.log(`🔑 Generated service identity → ${keyPath}`);
    return key;
  }
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
