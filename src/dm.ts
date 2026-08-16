import * as nip59 from "nostr-tools/nip59";
import { getPublicKey } from "nostr-tools/pure";
import type { Event } from "nostr-tools";

/**
 * Direct messages — NIP-17 private DMs (the decentralized standard),
 * deliberately NOT Buzz's relay-managed DM groups: their model needs a
 * relay identity signing per-viewer state (NIP-DV), which only works
 * when the relay is an authority. fez's relay is dumb storage, so DMs
 * are pure cryptography instead:
 *
 *   kind:14 rumor (unsigned chat message, real sender + timestamp)
 *     → NIP-59 seal (signed + NIP-44-encrypted by the sender)
 *       → kind:1059 gift wrap (random one-time key, p-tags ONLY the
 *         recipient, timestamp fuzzed up to 2 days back)
 *
 * Observers see: someone sent something to this pubkey, at roughly
 * some time. No sender, no content, no thread. Every message is
 * wrapped twice — once to the peer, once to the SENDER (the self-copy
 * is how your own other clients see what you sent).
 *
 * The rumor carries fez's depth tag: agent↔agent DMs are a private
 * ping-pong hazard exactly like channel replies, so the same
 * MAX_CHAIN_DEPTH loop guard rides inside the encryption.
 *
 * Subscription note for consumers: filter kinds [1059], "#p": [you],
 * and set `since` at least 2 days back — wrap timestamps are fuzzed
 * BACKWARDS, so a `since: now` filter misses live messages. Order
 * conversations by the RUMOR's created_at (real), never the wrap's.
 */

export const KIND_GIFT_WRAP = 1059;
export const KIND_DM = 14;

/** Wrap timestamps are fuzzed up to 2 days back — subscriptions must reach at least this far. */
export const DM_FUZZ_WINDOW_S = 2 * 86_400;

export interface DmRumor {
  /** The real sender. */
  senderPk: string;
  /** The peer of the conversation from OUR side: sender for received DMs, recipient for self-copies. */
  peerPk: string;
  text: string;
  /** Real timestamp (seconds) — the wrap's is fuzzed. */
  ts: number;
  /** Agent-chain depth carried inside the rumor (0 = human-originated). */
  depth: number;
  /** Rumor id — stable across the peer copy and the self-copy (same rumor, two wraps). */
  id: string;
}

/** Build both wraps for one DM: to the peer, and the sender's self-copy. */
export function buildDmWraps(
  senderSecret: Uint8Array,
  recipientPubkey: string,
  text: string,
  depth = 0
): { toPeer: Event; toSelf: Event } {
  const rumor = nip59.createRumor(
    {
      kind: KIND_DM,
      tags: [["p", recipientPubkey], ...(depth > 0 ? [["depth", String(depth)]] : [])],
      content: text,
    },
    senderSecret
  );
  const senderPk = getPublicKey(senderSecret);
  return {
    toPeer: nip59.createWrap(nip59.createSeal(rumor, senderSecret, recipientPubkey), recipientPubkey) as Event,
    toSelf: nip59.createWrap(nip59.createSeal(rumor, senderSecret, senderPk), senderPk) as Event,
  };
}

/**
 * Unwrap a gift wrap addressed to us. Returns undefined for wraps that
 * aren't ours, aren't chat rumors, or don't decrypt — all ignorable by
 * design (relays can be sloppy; #p filters can be loose).
 */
export function unwrapDm(event: Event, mySecret: Uint8Array): DmRumor | undefined {
  if (event.kind !== KIND_GIFT_WRAP) return undefined;
  try {
    const rumor = nip59.unwrapEvent(event, mySecret) as {
      kind: number;
      id: string;
      pubkey: string;
      content: string;
      created_at: number;
      tags: string[][];
    };
    if (rumor.kind !== KIND_DM || typeof rumor.content !== "string") return undefined;
    const myPk = getPublicKey(mySecret);
    const recipient = rumor.tags.find((t) => t[0] === "p")?.[1];
    const peerPk = rumor.pubkey === myPk ? recipient : rumor.pubkey;
    if (!peerPk) return undefined;
    return {
      senderPk: rumor.pubkey,
      peerPk,
      text: rumor.content,
      ts: rumor.created_at,
      depth: Number(rumor.tags.find((t) => t[0] === "depth")?.[1] ?? 0),
      id: rumor.id,
    };
  } catch {
    return undefined;
  }
}
