import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, getKey, resolveRelays, buildDmWraps } from "@fezchat/protocol";

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

const KIND_CHANNEL_MESSAGE = 47103;

/** Pure — the exact event a persona-authored channel post is, before signing. */
export function buildPersonaEvent(
  _secretHex: string,
  channelId: string,
  text: string,
  threadRoot?: string
): EventTemplate {
  const tags: string[][] = [["h", channelId]];
  if (threadRoot) tags.push(["e", threadRoot, "", "root"]);
  return { kind: KIND_CHANNEL_MESSAGE, created_at: Math.floor(Date.now() / 1000), tags, content: text };
}

/**
 * Publish `text` into a channel signed as `agent:<persona>` — the persona's
 * own stable keychain key, NOT the owner's. Same custody path fez-polls /
 * fez-kanban / fez-communities use. Returns the event id (so the caller can
 * record a thread root). Throws if the persona has no local key.
 */
export async function postAsPersona(
  persona: string,
  channelId: string,
  text: string,
  opts?: { threadRoot?: string; relays?: string[] }
): Promise<string> {
  const keyHex = getKey(`agent:${persona}`);
  if (!keyHex) throw new Error(`no local key for agent "${persona}"`);
  const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
  const relay = new RelayConnection({
    urls: resolveRelays(opts?.relays),
    authSigner: async (tmpl) => finalizeEvent(tmpl as never, secret),
  });
  const signed = finalizeEvent(buildPersonaEvent(keyHex, channelId, text, opts?.threadRoot) as never, secret);
  try {
    await relay.publish(signed);
  } finally {
    relay.disconnect();
  }
  return signed.id;
}

/**
 * DM the owner a status line signed as `agent:<persona>` — same custody path
 * as postAsPersona, but a NIP-17 gift-wrapped DM (buildDmWraps → publish both
 * the peer wrap and the sender self-copy) instead of a channel message.
 * Returns the peer wrap's event id. Throws if the persona has no local key.
 */
export async function dmOwnerAsPersona(persona: string, ownerPubkey: string, text: string): Promise<string> {
  const keyHex = getKey(`agent:${persona}`);
  if (!keyHex) throw new Error(`no local key for agent "${persona}"`);
  const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
  const relay = new RelayConnection({
    urls: resolveRelays(),
    authSigner: async (tmpl) => finalizeEvent(tmpl as never, secret),
  });
  const { toPeer, toSelf } = buildDmWraps(secret, ownerPubkey, text);
  try {
    await relay.publish(toPeer);
    await relay.publish(toSelf);
  } finally {
    relay.disconnect();
  }
  return toPeer.id;
}

/** Recover an existing persona root, including a validated legacy root recorded by the GUI. */
export async function findPersonaRoot(persona: string, channelId: string, text: string, recordedId?: string, relayUrl?: string): Promise<string | undefined> {
  const keyHex = getKey(`agent:${persona}`);
  if (!keyHex) throw Error(`no local key for agent "${persona}"`);
  const secret = Uint8Array.from(Buffer.from(keyHex,"hex"));
  const relay = new RelayConnection({urls:resolveRelays(relayUrl),authSigner:async tmpl=>finalizeEvent(tmpl as never,secret)});
  try {
    // ponytail: an exact recorded ID bypasses this window; a lost legacy root
    // older than 500 persona posts needs paginated recovery if required.
    const filters = [{kinds:[KIND_CHANNEL_MESSAGE],authors:[getPublicKey(secret)],"#h":[channelId],limit:500}];
    // ponytail: only unindexed legacy roots use this 500-message recovery window;
    // normal workspace switches use the persisted relay/channel root map.
    const { events, failures } = await relay.queryWithStatus(recordedId ? [...filters,{ids:[recordedId]}] : filters);
    if (failures.length) throw Error("Miner history could not be fully read. Reconnect and retry before creating a thread.");
    return events.filter(e=>e.kind === KIND_CHANNEL_MESSAGE && e.content === text && e.tags.some(t=>t[0] === "h" && t[1] === channelId)
      && !e.tags.some(t=>t[0] === "e" && (t[3] === "root" || t[3] === "reply")))
      .sort((a,b)=>a.created_at-b.created_at || a.id.localeCompare(b.id))[0]?.id;
  } finally { relay.disconnect(); }
}
