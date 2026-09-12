import * as nip59 from "nostr-tools/nip59";
import * as nip44 from "nostr-tools/nip44";
import { getPublicKey, validateEvent, verifyEvent } from "nostr-tools/pure";
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
  /**
   * The full conversation set — sender + every p-tagged recipient, sorted
   * unique. Two entries = classic 1:1; more = a group DM (one rumor,
   * one wrap per participant — still pure NIP-17, no relay involvement).
   */
  participants: string[];
}

/**
 * A conversation's stable key from MY point of view: the OTHER
 * participants, sorted, joined with "+". One other = their bare pubkey —
 * exactly the key 1:1 conversations always used, so group support
 * changes nothing for existing state.
 */
export function dmConvoKey(participants: string[], myPk: string): string {
  return [...new Set(participants)].filter((pk) => pk !== myPk).sort().join("+");
}

/** Build both wraps for one DM: to the peer, and the sender's self-copy. */
export function buildDmWraps(
  senderSecret: Uint8Array,
  recipientPubkey: string,
  text: string,
  depth = 0
): { toPeer: Event; toSelf: Event } {
  const { wraps } = buildGroupDmWraps(senderSecret, [recipientPubkey], text, depth);
  return { toPeer: wraps[0], toSelf: wraps[wraps.length - 1] };
}

/**
 * Group DM: ONE rumor p-tagging every recipient, wrapped separately for
 * each of them plus the sender's self-copy (last element). Everyone
 * decrypts the same rumor id and sees the same participant set, so all
 * clients derive the same conversation. Still nothing for the relay to
 * know: each wrap p-tags one recipient under a one-time key.
 */
export function buildGroupDmWraps(
  senderSecret: Uint8Array,
  recipientPubkeys: string[],
  text: string,
  depth = 0
): { wraps: Event[]; id: string } {
  const senderPk = getPublicKey(senderSecret);
  const others = [...new Set(recipientPubkeys)].filter((pk) => pk !== senderPk);
  if (others.length === 0) throw new Error("group DM needs at least one recipient besides the sender");
  const rumor = nip59.createRumor(
    {
      kind: KIND_DM,
      tags: [...others.map((pk) => ["p", pk]), ...(depth > 0 ? [["depth", String(depth)]] : [])],
      content: text,
    },
    senderSecret
  );
  const wraps = [...others, senderPk].map(
    (pk) => nip59.createWrap(nip59.createSeal(rumor, senderSecret, pk), pk) as Event
  );
  return { wraps, id: (rumor as { id: string }).id };
}

/**
 * Decryption alone does not authenticate a rumor's claimed sender.
 * Keep seal validation shared by headless DMs and the browser's local signer.
 */
export function unwrapGiftWrap(event: Event, mySecret: Uint8Array): ReturnType<typeof nip59.createRumor> | undefined {
  try {
    if (event.kind !== KIND_GIFT_WRAP || !verifyEvent(event)) return undefined;
    const seal: Event = JSON.parse(nip44.decrypt(event.content, nip44.getConversationKey(mySecret, event.pubkey)));
    if (seal.kind !== 13 || !verifyEvent(seal)) return undefined;
    const rumor: ReturnType<typeof nip59.createRumor> = JSON.parse(
      nip44.decrypt(seal.content, nip44.getConversationKey(mySecret, seal.pubkey))
    );
    if (!validateEvent(rumor) || typeof rumor.id !== "string" || rumor.pubkey !== seal.pubkey) return undefined;
    return rumor;
  } catch {
    return undefined;
  }
}

/**
 * Unwrap a gift wrap addressed to us. Returns undefined for wraps that
 * aren't ours, aren't chat rumors, or don't decrypt — all ignorable by
 * design (relays can be sloppy; #p filters can be loose).
 */
export function unwrapDm(event: Event, mySecret: Uint8Array): DmRumor | undefined {
  try {
    const rumor = unwrapGiftWrap(event, mySecret);
    if (!rumor || rumor.kind !== KIND_DM) return undefined;
    const myPk = getPublicKey(mySecret);
    const recipients = rumor.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]);
    const recipient = recipients[0];
    const peerPk = rumor.pubkey === myPk ? recipient : rumor.pubkey;
    if (!peerPk) return undefined;
    return {
      senderPk: rumor.pubkey,
      peerPk,
      text: rumor.content,
      ts: rumor.created_at,
      depth: Number(rumor.tags.find((t) => t[0] === "depth")?.[1] ?? 0),
      id: rumor.id,
      participants: [...new Set([rumor.pubkey, ...recipients])].sort(),
    };
  } catch {
    return undefined;
  }
}
