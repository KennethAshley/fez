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

/**
 * Owner attestation — owner-signed proof that a pubkey is their agent:
 * ["p", agentPubkey], empty content, signed by the owner. Agents use it
 * for sibling verification (Buzz's NIP-OA gate): respondTo=owner admits
 * the owner AND any author the owner has attested, so a user's agents
 * chain freely while strangers can't trigger them. Self-declared owner
 * claims are worthless — only the owner's signature proves the link.
 */
export const KIND_AGENT_ATTESTATION = 47006;
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
 * Presence heartbeat — ephemeral (relayed, never stored), Buzz's kind.
 * Every participant (TUI while open, agents while running) beats every
 * ~30s with empty-ish JSON content; online = heard from within a ~90s
 * TTL, resolved client-side. No explicit offline event — crash-safe by
 * construction, like typing indicators.
 */
export const KIND_PRESENCE = 20001;

/**
 * Draft — ephemeral streaming preview of a message being composed (an
 * agent's accumulated harness output mid-turn). Same tags as the eventual
 * 47103 (h/c + NIP-10 thread markers); content = the text so far.
 * Ephemeral: relayed live, never stored — late joiners and history see
 * only the final message. Receivers stream it into a live bubble and
 * adopt that bubble when the final message arrives.
 */
export const KIND_DRAFT = 20003;

/**
 * Observer frame — the owner-only half of the two-audience model (Buzz's
 * observer bus, decentralized): channels see final messages + presence;
 * the agent's OWNER sees the full activity firehose (thought chunks, tool
 * calls, turn lifecycle) as NIP-44-encrypted frames only they can read.
 * Ephemeral (live-only, never stored — and a sloppy relay storing them
 * leaks nothing, they're ciphertext). Tags ["p", ownerPubkey],
 * ["agent", personaName]; content = nip44(agentKey ↔ ownerPub) of
 * {type: "thought"|"tool"|"text"|"turn", text?, title?, status?, ts}.
 */
export const KIND_OBSERVER = 20004;

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

/**
 * Workflow run trace — one event per lifecycle transition of an
 * automation run (Buzz's workflow_runs table, decentralized): started,
 * step_done, waiting_approval, approved, timeout, done, failed. Published
 * by whatever workflow service the operator runs so ANY client can render
 * "what did my automations do" without knowing the engine. Tags
 * ["h", channelId], ["c", communityId], ["e", triggerEventId],
 * ["workflow", name]; content {workflow, run, status, step?, detail?}.
 * Same membership trust rule as messages — a workflow service is invited
 * like any agent.
 */
export const KIND_WORKFLOW_RUN = 47200;

/**
 * Agent engram — NIP-AE persistent agent memory (Buzz's spec,
 * implemented to the letter in src/engram.ts for cross-implementation
 * interop). Addressable: latest per (agent pubkey, d) wins. Signed by
 * the AGENT, NIP-44-encrypted under the agent↔owner conversation key —
 * symmetric, so the owner can always read everything the agent
 * remembers. d = HMAC(conversation key, slug): slugs leak nothing.
 * One "core" record (identity/rules/goals, injected into every turn's
 * standing context) plus mem/... entries; value:null = tombstone.
 */
export const KIND_AGENT_ENGRAM = 30174;

/**
 * Direct messages — NIP-17 (kind 14 rumor inside a kind 1059 NIP-59
 * gift wrap), implemented in src/dm.ts. The decentralized standard,
 * deliberately NOT Buzz's relay-managed DM groups + NIP-DV visibility
 * (those require a relay identity signing per-viewer state — server
 * authority fez's dumb relay rejects). The wrap p-tags only the
 * recipient under a random one-time key with a fuzzed timestamp;
 * sender, content, and the fez depth tag (agent-loop guard) all ride
 * encrypted inside the rumor. Constants re-exported from dm.ts.
 */
export { KIND_GIFT_WRAP, KIND_DM } from "./dm.js";

/**
 * Reaction — standard nostr kind 7, Buzz's shape: content = the emoji,
 * ["e", targetEventId], plus ["h", channelId] so clients can subscribe by
 * channel (Buzz derives the channel server-side from the e-target; fez's
 * dumb relay can't, so the tag rides the wire). Same membership trust
 * rule as messages.
 */
export const KIND_REACTION = 7;

/**
 * Deletion — standard nostr kind 5: e-tags name the author's own events to
 * retract. Fez's use (Buzz's model): agent status reactions are a lifecycle
 * — 👀 "seen, will handle" at accept time, 💬 "working" when the turn
 * starts, both deleted when the turn completes. Clients honor a deletion
 * only when its author matches the deleted event's author.
 */
export const KIND_DELETION = 5;

/**
 * Read state — client-signed, NIP-44 SELF-encrypted last-read marks
 * (Buzz's NIP-RS decision: unreads are private, derived client-side).
 * Parameterized-replaceable; ["d", channelId]; content = nip44(self) of
 * {last_read}. Latest per d wins.
 */
export const KIND_READ_STATE = 30078;

/**
 * Message ops (400xx, Buzz's stream-message op kinds): each targets a
 * 47103 via ["e", targetId] + ["h", channelId], ["c", communityId].
 * Trust rules are client-side: edits author-only latest-wins; pins/
 * bookmarks retract via kind 5 from their own author.
 */
export const KIND_MSG_EDIT = 40003;     // content = replacement text
export const KIND_MSG_PIN = 40004;      // channel-visible pin
export const KIND_MSG_BOOKMARK = 40005; // private-ish bookmark (author's own list)

/**
 * Intents the sentinel executes at the appointed time, then tombstones
 * (kind 5) so restarts never refire. 40006 scheduled message: h/c +
 * ["send_at", ts], content = the message. 40007 reminder: ["p", self],
 * content = NIP-44 self-encrypted {note, remind_at, about?} — reminders
 * are private data on a public relay (legacy plaintext form had a
 * remind_at tag; still decoded).
 */
export const KIND_SCHEDULED = 40006;
export const KIND_REMINDER = 40007;

/**
 * Channel doc — the living document per channel (Buzz's canvas 40100,
 * fez-shaped as versioned markdown). Regular kind = free history; tags
 * ["h", channelId], ["c", communityId], ["base", parentVersionId]? for
 * conflict detection; content = full markdown. Member-gated like
 * messages.
 */
export const KIND_DOC = 40100;

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
