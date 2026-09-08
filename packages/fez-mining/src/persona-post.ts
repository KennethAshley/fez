import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, getKey, resolveRelays } from "@fezchat/protocol";

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
  opts?: { threadRoot?: string }
): Promise<string> {
  const keyHex = getKey(`agent:${persona}`);
  if (!keyHex) throw new Error(`no local key for agent "${persona}"`);
  const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
  const relay = new RelayConnection({
    urls: resolveRelays(),
    authSigner: async (tmpl) => finalizeEvent(tmpl as never, secret),
  });
  const signed = finalizeEvent(buildPersonaEvent(keyHex, channelId, text, opts?.threadRoot) as never, secret);
  await relay.publish(signed);
  void getPublicKey; // (kept for parity with sibling servers; pubkey used by callers if needed)
  return signed.id;
}
