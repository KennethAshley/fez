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
 * Turn metric — durable per-turn cost/effort record (Buzz's kind 44200
 * decision, fez-numbered): published by the agent runtime after EVERY
 * turn, NIP-44-encrypted to the OWNER (cost data is private). Regular
 * kind = full history; /costs aggregates. Tags ["p", ownerPk],
 * ["agent", personaName]; content = nip44(agent↔owner) of {agent, scope,
 * status, durationMs, replyChars, usage?, ts} — usage carries whatever
 * token/cost figures the harness surfaced (absent when it surfaced none:
 * fail-closed, never estimated).
 */
export const KIND_TURN_METRIC = 47030;

/** A payment, e-tagged to the message it paid for. Signed by the payer;
 * verifiable by anyone against the block it names. */
export const KIND_PAYMENT_RECEIPT = 47040;

// 47041 is RESERVED: the bazaar's npub↔hotkey binding kind (fez-bazaar
// src/protocol/kinds.ts BINDING). It moved off 47040 to clear this
// registry's payment receipt; do not reuse the number here.

/**
 * Observer control — the reverse half of the observer stream (20004):
 * OWNER → agent commands as ephemeral NIP-44-encrypted frames. v1: {cmd:
 * "cancel", ts} aborts the in-flight turn (no steer re-dispatch — the
 * turn just stops, with a threaded notice). Freshness-windowed (±60s,
 * Buzz's decision) so a replayed frame can't cancel a future turn.
 * Encryption to the agent under the OWNER's key is the authorization —
 * nobody else can produce a frame that decrypts.
 */
export const KIND_OBSERVER_CONTROL = 20005;

/**
 * Report — standard NIP-56 kind 1984, fez-shaped for a PUBLIC relay:
 * the content ({targetPk, reason, aboutEventId?}) is NIP-44-encrypted
 * to the workspace OWNER — an accusation is private data between the
 * reporter and the moderator (Buzz keeps its report queue server-side
 * private for the same reason). Tags ["h", channelId], ["p", ownerPk]
 * so owners can subscribe; observers learn only "someone reported
 * something in this channel".
 *
 * Reports written before the workspace went flat carry ["c", communityId]
 * instead; readers should accept either so an existing queue keeps
 * rendering.
 */
export const KIND_REPORT = 1984;

/**
 * Ban list — owner-signed moderation state for the workspace
 * (Buzz's 9040-44 relay commands, decentralized): parameterized-
 * replaceable, d = BANS_D, p tags = banned pubkeys. Only the workspace
 * owner's latest counts (same trust chain as 47102).
 * Enforcement: clients treat banned pubkeys as non-members EVERYWHERE
 * membership is checked (messages, reactions, pins, docs) without
 * touching the roster — /unban restores standing instantly. Relay-side,
 * moderationPolicy() rejects their writes and withholds their reads.
 */
export const KIND_BAN_LIST = 30047;

/**
 * Device pairing — NIP-AB's decisions (Buzz pairing-cli), fez-shaped:
 * ephemeral handshake frames moving the keychain identity to a second
 * device. Ephemeral range (relayed, never stored); content is NIP-44
 * ciphertext between two throwaway keys; a human-compared 6-digit SAS
 * derived from both ephemeral pubkeys is the MITM defense. See
 * src/pairing.ts.
 */
export const KIND_PAIRING = 24134;

/**
 * Workspaces/channels (471xx). **A relay IS a workspace** — Slack's model,
 * Buzz's model: "Raleigh, NC" is a relay holding #food, #sports, #weather,
 * and adding the relay is joining it. There is no community event; the
 * workspace's identity is the relay URL and its metadata comes from the
 * relay's own NIP-11 document (name, description, icon).
 *
 * Trust — flattening the STRUCTURE does not hand authority to the RELAY:
 *
 * - The workspace's **owner** is a pubkey the relay advertises in NIP-11
 *   (`pubkey`, the standard administrative-contact field). Buzz makes the
 *   relay sign its own roster; fez keeps a person signing, so moving hosts
 *   and keeping the key keeps the workspace.
 * - 47101/47102/30047 count only when signed by that owner. A relay that
 *   lies about its owner can only make its own events be ignored.
 * - Regular (non-replaceable) kinds: relays keep every version; among the
 *   owner's events with the same d-tag the highest created_at wins, ties
 *   broken by lowest id, resolved client-side.
 * - A 47103 renders only if its author is on the workspace roster.
 *
 * Membership is **workspace-wide, not per channel**: you are invited to
 * the workspace and you see every channel in it. One roster, one d-tag.
 */
/**
 * Channel. Owner-signed; ["d", channelId].
 *
 * content: {name, description?, visibility, source?, meta?}
 *
 * `source` names what MADE the channel when it wasn't a person —
 * "github", "email" — so a client can group a bridge's channels under
 * one heading instead of scattering a repo per line among the rooms
 * people opened. `meta` is whatever the maker needs to recognise it
 * again (the full owner/name behind a short repo channel). Both are
 * hints for presentation: they carry no authority, and a client that
 * ignores them loses nothing but the grouping.
 *
 * Extensions should reach these through src/channels.ts rather than
 * building the event, so the vocabulary has one definition.
 */
export const KIND_CHANNEL = 47101;
export const KIND_MEMBERSHIP = 47102;      // owner-signed; ["d", ROSTER_D], ["p", pubkey, role]*; owner|admin|member|bot
export const KIND_CHANNEL_MESSAGE = 47103; // any member; ["h", channelId], ["p", mentionPubkey]*; content = text

/**
 * The workspace roster's d-tag. A fixed string because there is exactly
 * one roster per workspace — the relay is the scope, so nothing else is
 * needed to name it.
 */
export const ROSTER_D = "roster";

/** The ban list's d-tag — workspace-wide, same reasoning as ROSTER_D. */
export const BANS_D = "bans";

/**
 * RETIRED — kind 47100 was the community event, back when a relay could
 * hold many communities. The workspace is the relay now. The constant
 * stays exported (and the number stays burned) so a stale event can be
 * recognised and ignored rather than silently reinterpreted, and so no
 * future kind reuses the number.
 */
export const KIND_COMMUNITY_RETIRED = 47100;

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

/** Where an agent can be paid — addressable, d = "<chain>:<network>",
 * content = the address. Published by the wallet extension and signed by
 * the agent's own key. */
export const KIND_AGENT_PAYMENT_ADDRESS = 30175;

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
 * Profile — standard nostr kind 0 (replaceable): self-attested display
 * name so a second HUMAN in your community isn't a hex string, and the
 * first point of interop with ordinary nostr clients. content JSON
 * {name, display_name?}. Agents keep announcing via 47000, which outranks
 * kind 0 in display resolution (routing names are load-bearing).
 */
export const KIND_PROFILE = 0;

/**
 * User status — NIP-38 kind 30315 ("away", "deep work"); d="general",
 * content = the status text, empty content clears. Complements the
 * presence dot (online/offline) with intent.
 */
export const KIND_USER_STATUS = 30315;

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
 * 40006 content is either legacy plaintext (the message text; sentinel-
 * fired) or a SEALED intent: JSON {sealed: <full signed 47103 with
 * created_at = send_at>} released verbatim by the relay scheduler or the
 * sentinel at fire time — see src/protocol/intents.ts.
 */
export const KIND_SCHEDULED = 40006;
export const KIND_REMINDER = 40007;

/**
 * Reminder v2 — parameterized replaceable, addressed by its `d` tag.
 *
 * The v1 40007 above is a REGULAR event: every edit would be another row
 * and cancelling needs a kind-5 tombstone, so snooze and complete have
 * nowhere to live. Replaceable makes all three one operation — republish
 * the address with a different `status` — and the relay keeps only the
 * newest, so nothing accumulates.
 *
 * The due time rides a PUBLIC `due` tag while note/status/target stay
 * NIP-44 self-encrypted. That is Buzz's split (their `not_before`): a
 * relay can see WHEN a reminder is due without seeing WHAT it says,
 * which is the precondition for anything but a live client delivering
 * it. Nothing serves that yet in fez — the desktop's own timer does the
 * work — but the tag costs nothing now and cannot be added later without
 * rewriting every stored reminder.
 */
export const KIND_REMINDER_V2 = 30176;

/**
 * Channel doc — the living document per channel (Buzz's canvas 40100,
 * fez-shaped as versioned markdown). Regular kind = free history; tags
 * ["h", channelId], ["c", communityId], ["base", parentVersionId]? for
 * conflict detection; content = full markdown. Member-gated like
 * messages.
 */
export const KIND_DOC = 40100;

/**
 * Doc comment — a Notion-style margin note anchored to a line of a doc
 * or wiki page, and the way you hand an agent work inside a document.
 * Tags: ["h", channelId], ["c", communityId] (member gating, same as
 * the doc), ["d", slug]? for wiki pages, ["anchor", lineText] — the
 * TEXT of the commented line, not its number, so a comment survives
 * edits above it; ["e", parentCommentId] for replies; ["p", pk] per
 * @mention (an @agent mention summons it, same as in chat);
 * ["resolved", "1"] on a resolving event. Content = markdown.
 */
export const KIND_DOC_COMMENT = 40101;

/**
 * Doc task state — one checkbox in a document, ticked or unticked.
 *
 * Deliberately NOT a rewrite of the doc: checking a box would otherwise
 * publish a whole new 40100 version, which collides with anyone editing
 * the same page and buries the history under bookkeeping. Instead the
 * markdown keeps the item (`- [ ] ship the thing`) and this event
 * carries whether it is done — so a bare client still reads the list,
 * and every tick is attributable.
 *
 * Tags: ["h", channelId], ["c", communityId] (member gating),
 * ["d", slug]? for wiki pages, ["t", itemKey] (normalized item TEXT, so
 * a task survives edits elsewhere in the doc), ["done", "1" | "0"].
 * Latest event per (doc, itemKey) wins.
 */
export const KIND_DOC_TASK = 40102;

/**
 * Skill listing — the decentralized skills marketplace. A signed,
 * addressable advertisement for an MCP server config: ["d", skillName];
 * content = JSON {name, description, command, args, envKeys, homepage}.
 * envKeys are NAMES ONLY — secret values never ride the wire; the
 * installer fills them locally. Installing a listing means writing your
 * OWN settings.json catalog after reading the command — a listing is a
 * recommendation from its author's pubkey, never something that runs by
 * itself (the same review posture as persona drafts).
 */
export const KIND_SKILL_LISTING = 40200;

/**
 * Install receipt — the decentralized download counter: a tiny signed
 * event published when someone installs from a listing (["skill", name],
 * ["p", listingAuthor]). Counts are distinct signer pubkeys — sybil-able
 * like every counter ever, but each count is at least a real keypair
 * vouching in public. Publishing one is the installer's choice.
 */
export const KIND_SKILL_INSTALL = 40201;

/**
 * Typed artifact — how agents ship non-text output (canvas, html,
 * pdf, table…) without binding the protocol to any renderer. ["h"],
 * ["c"] like messages (member-gated), ["type", slug]; content = JSON
 * {type, title, url? (Blossom blob), content? (small inline payload)}.
 * Bare clients render title+link; richer clients register viewers per
 * type — the wire stays universal, the GUI stays optional.
 */
export const KIND_ARTIFACT = 40300;

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
