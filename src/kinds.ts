/**
 * Fez event kind registry.
 * Agents communicate via standard Nostr events with these kind numbers.
 */

export const KIND_AGENT_METADATA = 47000;
export const KIND_AGENT_TASK = 47001;
export const KIND_AGENT_PROGRESS = 47002;
export const KIND_AGENT_RESULT = 47003;
export const KIND_AGENT_DM = 47004;
export const KIND_AGENT_CAPABILITY = 47005;
export const KIND_AGENT_DELEGATION = 47010;
export const KIND_AGENT_REVOKE = 47011;
export const KIND_AGENT_CANCEL = 47012;
export const KIND_AGENT_AUDIT = 47020;

/**
 * Communities/channels (471xx). Client-side trust model — every participant
 * runs fez, so all clients apply the same rules; the relay is dumb storage:
 *
 * - The author of a community's 47100 (d = community id) is that
 *   community's root of trust.
 * - 47101/47102 events count only when signed by the community creator.
 * - These are regular (non-replaceable) kinds — relays keep every version;
 *   among a creator's 47102s with the same d-tag, highest created_at wins,
 *   resolved client-side.
 * - A 47103 renders only if its author is in the channel's winning 47102
 *   membership. Signature validity comes free from nostr-tools.
 */
export const KIND_COMMUNITY = 47100;       // creator-signed; ["d", communityId]; content {name, description}
export const KIND_CHANNEL = 47101;         // creator-signed; ["d", channelId], ["c", communityId]; content {name, description, visibility}
export const KIND_MEMBERSHIP = 47102;      // creator-signed; ["d", channelId], ["c", communityId], ["p", pubkey, role]*; owner|admin|member|bot
export const KIND_CHANNEL_MESSAGE = 47103; // any member; ["h", channelId], ["c", communityId], ["p", mentionPubkey]*; content = text

/**
 * Typing indicator — nostr ephemeral range (relays broadcast, never store;
 * dev/relay.ts honors this), same kind number Buzz uses. ["h", channelId];
 * content {name}. Publishers heartbeat while composing/working; receivers
 * expire the indicator client-side a few seconds after the last one.
 */
export const KIND_TYPING = 20002;

/**
 * Thread summary — the indexer pattern: a standing service watches channel
 * messages, maintains derived stats in whatever storage its operator
 * brings, and publishes these back so clients get counts without having
 * seen every message (Buzz's relay-signed 39005 overlay, decentralized).
 * Parameterized-replaceable range: real relays keep only the latest per
 * (pubkey, kind, d); clients apply latest-created_at-wins regardless.
 * Tags ["d", rootEventId], ["h", channelId], ["c", communityId];
 * content {replyCount, lastReplyAt, participants}. Trust rule: consumers
 * accept a summary only if its author is in the channel's winning 47102
 * membership — an indexer is invited like any agent.
 */
export const KIND_THREAD_SUMMARY = 39005;

export const AGENT_KINDS = [
  KIND_AGENT_METADATA,
  KIND_AGENT_TASK,
  KIND_AGENT_PROGRESS,
  KIND_AGENT_RESULT,
  KIND_AGENT_DM,
  KIND_AGENT_CAPABILITY,
  KIND_AGENT_DELEGATION,
  KIND_AGENT_REVOKE,
  KIND_AGENT_CANCEL,
  KIND_AGENT_AUDIT,
] as const;
