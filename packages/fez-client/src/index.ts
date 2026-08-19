export { parseQuery, describeQuery, type Query, type QuerySource, type QueryView } from "./query-lang.js";
import { CommunityState, setStatePersistence, type Role, type StatePersistence } from "./community-state.js";

/**
 * @fez/client — the headless fez protocol brain: subscriptions, trust
 * rules, derived state, and actions, with no UI anywhere. The TUI, a
 * future GUI, and extensions all consume ONE instance per process via
 * FezExtensionAPI.client; state is a materialized view of the relay
 * (throw the process away, the next start re-derives it — the relay is
 * the database).
 *
 * The wire seam is deliberately the same shape as the TUI's NostrAccess
 * backend, so hosting the client inside the TUI costs nothing and a
 * standalone host only needs to assemble the same eight functions.
 *
 * Every trust rule ported here is Buzz-derived and documented at its
 * enforcement site: creator-signed channel state, member-gated
 * messages/ops, author-only edits and retractions, owner-decrypted
 * observer frames, self-encrypted read state.
 */

// ── Wire ──────────────────────────────────────────────────────────────────

export interface WireEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

export interface WireFilter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  /** NIP-50 full-text query (fez-relay: case-insensitive AND over tokens). */
  search?: string;
  [key: `#${string}`]: string[] | undefined;
}

export interface DmRumor {
  senderPk: string;
  peerPk: string;
  text: string;
  ts: number;
  depth: number;
  id: string;
  /** Full conversation set (sender + recipients, sorted). >2 = group DM. */
  participants?: string[];
}

/** Conversation key from MY side: other participants sorted, "+"-joined (1:1 = bare peer pk). */
export function dmConvoKey(participants: string[], myPk: string): string {
  return [...new Set(participants)].filter((pk) => pk !== myPk).sort().join("+");
}

/** Exactly the TUI's NostrAccess backend shape — the client's only dependency. */
export interface Wire {
  pubkey: string;
  publish(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent>;
  subscribe(filters: WireFilter[], onEvent: (event: WireEvent) => void): () => void;
  query(filters: WireFilter[]): Promise<WireEvent[]>;
  encrypt(peerPubkey: string, plaintext: string): string;
  decrypt(peerPubkey: string, ciphertext: string): string;
  sendDm(recipientPubkey: string, text: string): Promise<string>;
  /** Group DM (one rumor, one wrap per recipient + self-copy). Optional — older backends are 1:1 only. */
  sendGroupDm?(recipientPubkeys: string[], text: string): Promise<string>;
  unwrapDm(event: WireEvent): DmRumor | undefined;
}

// ── Kinds (fez registry — see src/kinds.ts for the full docs) ────────────
// Duplicated by design (this package stays dependency-light), exported so
// the registry-agreement gate in fez-evals can prove it never drifts from
// src/kinds.ts.

export const K = {
  AGENT_METADATA: 47000,
  COMMUNITY: 47100,
  CHANNEL: 47101,
  MEMBERSHIP: 47102,
  MESSAGE: 47103,
  TYPING: 20002,
  PRESENCE: 20001,
  DRAFT: 20003,
  OBSERVER: 20004,
  THREAD_SUMMARY: 39005,
  WORKFLOW_RUN: 47200,
  REACTION: 7,
  DELETION: 5,
  GIFT_WRAP: 1059,
  DOC: 40100,
  DOC_COMMENT: 40101,
  DOC_TASK: 40102,
  MSG_EDIT: 40003,
  MSG_PIN: 40004,
  MSG_BOOKMARK: 40005,
  SCHEDULED: 40006,
  REMINDER: 40007,
  READ_STATE: 30078,
  PROFILE: 0,
  USER_STATUS: 30315,
  BAN_LIST: 30047,
  ARTIFACT: 40300,
} as const;

const DM_FUZZ_WINDOW_S = 2 * 86_400;
const PRESENCE_TTL_MS = 90_000;
const PRESENCE_BEAT_MS = 30_000;
const TYPING_TTL_MS = 8000;
const MSG_CACHE_CAP = 1000;
const HISTORY_LIMIT = 50;
const PAGE_SIZE = 50;
const JOB_CAP = 100;

// ── Public state shapes ──────────────────────────────────────────────────

export interface Msg {
  id: string;
  authorPk: string;
  authorName: string;
  content: string;
  parentId?: string;
  rootId?: string;
  ts: number;
  edited?: boolean;
  editTs?: number;
  /** Honest tombstone (Buzz's decision: a visible removal, not a silent hole). */
  deletedBy?: "author" | "moderator";
}

export interface Job {
  triggerId: string;
  agentPk: string;
  channelId: string;
  status: "seen" | "working" | "done" | "failed" | "steered";
  startedAt: number;
  endedAt?: number;
  rootId: string;
  snippet: string;
  currentTool?: string;
}

export interface ObserverEntry {
  type: string;
  text?: string;
  title?: string;
  status?: string;
  /** ACP ToolKind classification (read|edit|execute|search|…). */
  kind?: string;
  /** Correlates update frames with their tool call — renderers merge on this. */
  callId?: string;
  /** First file path the tool touches. */
  path?: string;
  /** Source-truncated file modification for edit-class tools. */
  diff?: { path: string; oldText?: string; newText: string };
  ts: number;
}

/** Typed agent output (kind 40300): canvas/html/pdf/table — the wire
 * carries type+payload; RENDERING is the client's business (viewers
 * register per type; bare clients show title+link). */
export interface Artifact {
  id: string;
  authorPk: string;
  authorName: string;
  type: string;
  title?: string;
  url?: string;
  content?: string;
  ts: number;
}

export interface DmMessage {
  id: string;
  senderPk: string;
  text: string;
  ts: number;
}

export interface DocInfo {
  count: number;
  latestId: string;
  latestTs: number;
  latestAuthor: string;
  latestContent: string;
}

/**
 * A named wiki page — a 40100 doc with a ["d", slug] tag. Same event
 * kind, same versioning, same member gating as channel docs; the slug
 * makes it addressable so pages can [[link]] to one another. Scoped to
 * a community; the h tag is the channel it was written from (gating).
 */
export interface WikiDoc extends DocInfo {
  slug: string;
  title: string;
  channelId: string;
  communityId: string;
}

export interface DocCommentReply {
  id: string;
  authorPk: string;
  text: string;
  ts: number;
}

/** A comment thread anchored to a line of a doc (Notion's margin note). */
export interface DocCommentThread extends DocCommentReply {
  anchor: string;
  resolved: boolean;
  replies: DocCommentReply[];
}

/**
 * A checkbox's identity is its TEXT, normalized — the same anchoring
 * rule comments use. Reordering a list or editing the line above must
 * not untick something; editing the item itself intentionally does
 * (it is a different task now).
 */
export * from "./mentions.js";
import { resolveMentions, type MentionCandidate, type MentionResolution } from "./mentions.js";

export function taskKey(itemText: string): string {
  return itemText.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

export interface TaskState {
  done: boolean;
  byPk: string;
  ts: number;
}

/** [[Page Name]] → "page-name" — one slug rule everywhere (GUI, mcp, TUI). */
export function wikiSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-");
}

/**
 * Put a document's versions in order, oldest first — with the guarantee
 * that the LAST one is genuinely current.
 *
 * Sorting by timestamp is not enough. Every version carries a `base`
 * tag naming the version it was written on top of, and edits made in
 * quick succession — an agent moving two cards, a fast pair of drags on
 * a board — land in the same second. Two versions then tie, and which
 * one a reader calls "latest" comes down to the order a relay happened
 * to return them. The next edit bases itself on that answer, so the
 * loser's change silently disappears.
 *
 * The base chain says what came after what without consulting a clock:
 * the current version is the one nothing else was written on top of.
 * Timestamps only break ties between genuinely concurrent branches —
 * two people who edited the same base, where somebody's edit has to
 * lose and the version list is there to show them it happened.
 */
export function orderVersions<T extends { id: string; created_at: number; tags: string[][] }>(events: T[]): T[] {
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1));
  if (sorted.length < 2) return sorted;
  const superseded = new Set(
    events.map((event) => event.tags.find((t) => t[0] === "base")?.[1]).filter((id): id is string => !!id)
  );
  const tips = sorted.filter((event) => !superseded.has(event.id));
  const tip = tips[tips.length - 1];
  // No tip means the base tags form a cycle — corrupt, but not worth
  // throwing over; the timestamp order is still something to show.
  if (!tip || sorted[sorted.length - 1].id === tip.id) return sorted;
  return [...sorted.filter((event) => event.id !== tip.id), tip];
}

export interface PinInfo {
  opId: string;
  by: string;
  ts: number;
}

export interface WorkflowRunInfo {
  workflow: string;
  status: string;
  step?: number;
  ts: number;
}

export interface ClientEvents {
  /** A channel message entered the cache. live=false during history backfill/paging. */
  message: (channelId: string, msg: Msg, ctx: { live: boolean; prepend: boolean }) => void;
  /** Content of an existing message changed (40003 edit). */
  messageEdited: (channelId: string, msg: Msg) => void;
  /** A message became a tombstone (kind 5 from its author or the community creator). */
  messageDeleted: (channelId: string, msg: Msg) => void;
  /** Something on a message's footer changed: pin, thread count, edit marker. */
  metaChanged: (channelId: string, msgId: string) => void;
  /** Reactions on a target changed (add or retract). */
  reaction: (channelId: string, targetId: string) => void;
  /** Streaming draft frame from another participant. */
  draft: (channelId: string, authorPk: string, content: string, rootId?: string) => void;
  typingChanged: () => void;
  presenceChanged: () => void;
  unreadsChanged: () => void;
  /** Channel/community/membership set changed. */
  channelsChanged: () => void;
  dmMessage: (dm: DmMessage & { peerPk: string }, ctx: { live: boolean }) => void;
  docChanged: (channelId: string) => void;
  jobsChanged: () => void;
  observerFrame: (agent: string, frame: ObserverEntry) => void;
  workflowRunsChanged: () => void;
  /** A typed artifact landed in a channel. */
  artifact: (channelId: string, artifact: Artifact) => void;
  /** Client-level announcements a view should surface (first-run bootstrap etc.). */
  notice: (text: string) => void;
}

export { setStatePersistence, type StatePersistence };

export class FezClient {
  readonly state = new CommunityState();
  readonly pubkey: string;

  private wire: Wire;
  private listeners = new Map<keyof ClientEvents, Set<(...args: never[]) => void>>();
  private unsubscribeLive?: () => void;
  private subscribedChannelIds = "";
  private sessionStartS = Math.floor(Date.now() / 1000);

  // messages + threads
  private names = new Map<string, string>();
  private profiles = new Map<string, string>(); // kind-0 name/display_name — humans stop being hex
  private statuses = new Map<string, string>(); // kind-30315 status text
  private seenMessages = new Set<string>();
  private messagesByChannel = new Map<string, Msg[]>();
  private msgByIdMap = new Map<string, Msg>();
  private threadNoByRoot = new Map<string, number>();
  private rootByThreadNoMap = new Map<number, string>();
  private nextThreadNo = 1;
  private summaryByRoot = new Map<string, { replyCount: number; lastAuthorTs: number; summaryTs: number }>();
  private exhaustedChannels = new Set<string>();

  // reactions
  private reactionsByTarget = new Map<string, Map<string, Set<string>>>();
  private reactionIndex = new Map<string, { targetId: string; emoji: string; authorPk: string }>();

  // ops
  private pinsByChannel = new Map<string, Map<string, PinInfo>>();
  private myBookmarksMap = new Map<string, { opId: string; ts: number; channelId: string }>();
  private opIndex = new Map<string, { type: "pin" | "bookmark"; channelId: string; targetId: string; by: string }>();

  // presence + read state
  private lastSeenByPk = new Map<string, number>();
  private lastReadByChannel = new Map<string, number>();
  private readPublishTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // typing
  private typing = new Map<string, { pubkey: string; threadRoot?: string; expiry: number }>();

  // jobs + observer + workflows
  private jobsMap = new Map<string, Job>();
  private observerFeedsMap = new Map<string, ObserverEntry[]>();
  private workingAgentsMap = new Map<string, { activity: string; ts: number }>();
  private workflowRunsMap = new Map<string, WorkflowRunInfo>();

  // DMs
  private dmConvos = new Map<string, { msgs: DmMessage[]; unread: number; participants?: string[] }>();
  private seenDmIds = new Set<string>();

  // docs
  private docsByChannelMap = new Map<string, DocInfo>();
  private wikiMap = new Map<string, WikiDoc>();
  private artifactsByChannel = new Map<string, Artifact[]>();
  private seenArtifactIds = new Set<string>();
  private seenDocIds = new Set<string>();

  constructor(wire: Wire) {
    this.wire = wire;
    this.pubkey = wire.pubkey;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  on<E extends keyof ClientEvents>(event: E, handler: ClientEvents[E]): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(handler as (...args: never[]) => void);
    return () => set!.delete(handler as (...args: never[]) => void);
  }

  private emit<E extends keyof ClientEvents>(event: E, ...args: Parameters<ClientEvents[E]>): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        (handler as (...a: Parameters<ClientEvents[E]>) => void)(...args);
      } catch {
        /* a broken listener must not break the client */
      }
    }
  }

  // ── Read surface ────────────────────────────────────────────────────────

  displayName(pk: string): string {
    // Agent announcements (47000) outrank kind-0 profiles: an agent's
    // routing name is load-bearing, a human's profile is cosmetic.
    return pk === this.pubkey ? "You" : this.names.get(pk) ?? this.profiles.get(pk) ?? `${pk.slice(0, 8)}…`;
  }
  nameOf(pk: string): string | undefined {
    return this.names.get(pk) ?? this.profiles.get(pk);
  }
  /** Kind-30315 status text ("away", "deep work"), if the pubkey set one. */
  statusOf(pk: string): string | undefined {
    return this.statuses.get(pk);
  }
  /** Agents we know of (kind-47000 metadata authors): pk → persona name. */
  agents(): Map<string, string> {
    return new Map(this.names);
  }
  private agentMeta = new Map<string, { about?: string; skills?: string[] }>();
  /** What an agent announced about itself (47000 about/skills) — undefined for humans. */
  agentInfo(pk: string): { about?: string; skills?: string[] } | undefined {
    return this.agentMeta.get(pk);
  }

  /** Every pubkey we can name (agents outrank profiles) — autocomplete fodder. */
  knownNames(): Map<string, string> {
    const merged = new Map<string, string>(this.profiles);
    for (const [pk, name] of this.names) merged.set(pk, name);
    return merged;
  }

  /**
   * Everyone on a channel's roster, with the name they publish for
   * themselves — the candidate set for resolving @mentions there.
   *
   * Membership is creator-signed, so this is the one authority over
   * "who is in this room". Names remain self-asserted and non-unique;
   * resolveMentions() handles the collisions rather than hiding them.
   */
  mentionCandidates(channelId: string): MentionCandidate[] {
    const communityId = this.state.communityOfChannel(channelId);
    const channel = communityId ? this.state.community(communityId)?.channels.get(channelId) : undefined;
    const out: MentionCandidate[] = [];
    const seen = new Set<string>();
    for (const pubkey of channel?.members.keys() ?? []) {
      const name = this.names.get(pubkey) ?? this.profiles.get(pubkey);
      if (!name || seen.has(pubkey)) continue;
      seen.add(pubkey);
      out.push({ pubkey, name, isMember: true });
    }
    return out;
  }

  /**
   * Resolve the @mentions in a message against a channel's roster.
   * Returns the pubkeys to tag plus what went wrong, so a caller can
   * tell the sender rather than dropping a mention in silence.
   */
  resolveMentionsIn(text: string, channelId: string): MentionResolution {
    return resolveMentions(text, this.mentionCandidates(channelId));
  }

  /**
   * @deprecated Resolves against every name this client has ever seen,
   * first match wins, unordered — so a stranger sharing a name can win.
   * Use resolveMentionsIn() for anything that turns text into p tags;
   * this remains for lookups where the caller already knows the scope
   * (a persona name from local config, a command argument).
   */
  pkByName(name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [pk, n] of this.names) if (n.toLowerCase() === wanted) return pk;
    for (const [pk, n] of this.profiles) if (n.toLowerCase() === wanted) return pk;
    return undefined;
  }
  messages(channelId: string): readonly Msg[] {
    return this.messagesByChannel.get(channelId) ?? [];
  }
  msgById(id: string): Msg | undefined {
    return this.msgByIdMap.get(id);
  }
  threadNo(rootId: string): number {
    let no = this.threadNoByRoot.get(rootId);
    if (no === undefined) {
      no = this.nextThreadNo++;
      this.threadNoByRoot.set(rootId, no);
      this.rootByThreadNoMap.set(no, rootId);
    }
    return no;
  }
  rootByThreadNo(no: number): string | undefined {
    return this.rootByThreadNoMap.get(no);
  }
  threadNumbers(): ReadonlyMap<number, string> {
    return this.rootByThreadNoMap;
  }
  threadReplies(channelId: string, rootId: string): Msg[] {
    return (this.messagesByChannel.get(channelId) ?? []).filter((m) => m.rootId === rootId);
  }
  threadReplyCount(channelId: string, rootId: string): number {
    const local = this.threadReplies(channelId, rootId).length;
    return Math.max(local, this.summaryByRoot.get(rootId)?.replyCount ?? 0);
  }
  /** message id -> emoji -> display names — footer rendering data. */
  reactions(targetId: string): ReadonlyMap<string, ReadonlySet<string>> | undefined {
    return this.reactionsByTarget.get(targetId);
  }
  pins(channelId: string): ReadonlyMap<string, PinInfo> {
    return this.pinsByChannel.get(channelId) ?? new Map();
  }
  isPinned(channelId: string, msgId: string): boolean {
    return this.pinsByChannel.get(channelId)?.has(msgId) ?? false;
  }
  myBookmarks(): ReadonlyMap<string, { opId: string; ts: number; channelId: string }> {
    return this.myBookmarksMap;
  }
  isOnline(pk: string): boolean {
    return Date.now() - (this.lastSeenByPk.get(pk) ?? 0) < PRESENCE_TTL_MS;
  }
  unreadCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [channelId, list] of this.messagesByChannel) {
      if (this.state.scope?.channelId === channelId) continue;
      const lastRead = this.lastReadByChannel.get(channelId) ?? 0;
      const n = list.filter((m) => m.ts > lastRead && m.authorPk !== this.pubkey).length;
      if (n > 0) counts.set(channelId, n);
    }
    return counts;
  }
  /** Who is typing in the given scope (undefined root = channel level). */
  typingWho(threadRoot?: string): string[] {
    const now = Date.now();
    for (const [key, t] of this.typing) if (t.expiry <= now) this.typing.delete(key);
    return [...this.typing.values()].filter((t) => t.threadRoot === threadRoot).map((t) => this.displayName(t.pubkey));
  }
  jobs(): ReadonlyMap<string, Job> {
    return this.jobsMap;
  }
  activeJobs(): Job[] {
    return [...this.jobsMap.values()].filter((j) => j.status === "seen" || j.status === "working");
  }
  workflowRuns(): ReadonlyMap<string, WorkflowRunInfo> {
    return this.workflowRunsMap;
  }
  observerFeed(agent: string): readonly ObserverEntry[] {
    return this.observerFeedsMap.get(agent) ?? [];
  }
  workingAgents(): ReadonlyMap<string, { activity: string; ts: number }> {
    const now = Date.now();
    for (const [name, w] of this.workingAgentsMap) if (now - w.ts > 180_000) this.workingAgentsMap.delete(name);
    return this.workingAgentsMap;
  }
  dmConversations(): ReadonlyMap<string, { msgs: readonly DmMessage[]; unread: number }> {
    return this.dmConvos;
  }
  docsByChannel(): ReadonlyMap<string, DocInfo> {
    return this.docsByChannelMap;
  }
  artifacts(channelId: string): readonly Artifact[] {
    return this.artifactsByChannel.get(channelId) ?? [];
  }
  channelExhausted(channelId: string): boolean {
    return this.exhaustedChannels.has(channelId);
  }
  channelRef(channelId: string): { communityId: string; name: string; communityName: string } | undefined {
    for (const communityId of this.state.joined) {
      const community = this.state.community(communityId);
      const channel = community?.channels.get(channelId);
      if (community && channel) return { communityId, name: channel.name, communityName: community.name };
    }
    return undefined;
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Publish into the scoped channel. Thread tags follow Buzz's NIP-10 shape when replying. */
  async sendChannelMessage(text: string, opts?: { threadRootId?: string; mentionPks?: string[] }): Promise<Msg> {
    const current = this.state.currentChannel();
    if (!current) throw new Error("no channel scope");
    const threadTags: string[][] = [];
    if (opts?.threadRootId) {
      const replies = this.threadReplies(current.channel.id, opts.threadRootId);
      const parentId = replies.at(-1)?.id ?? opts.threadRootId;
      if (parentId !== opts.threadRootId) threadTags.push(["e", opts.threadRootId, "", "root"]);
      threadTags.push(["e", parentId, "", "reply"]);
    }
    const event = await this.wire.publish({
      kind: K.MESSAGE,
      tags: [
        ["h", current.channel.id],
        ["c", current.community.id],
        ...threadTags,
        ...(opts?.mentionPks ?? []).map((pk) => ["p", pk]),
      ],
      content: text,
    });
    this.seenMessages.add(event.id);
    return this.cacheMessage(current.channel.id, event);
  }

  async editLastOwnMessage(channelId: string, communityId: string, text: string): Promise<Msg | undefined> {
    const target = (this.messagesByChannel.get(channelId) ?? []).filter((m) => m.authorPk === this.pubkey).at(-1);
    if (!target) return undefined;
    const event = await this.wire.publish({
      kind: K.MSG_EDIT,
      tags: [["e", target.id], ["h", channelId], ["c", communityId]],
      content: text,
    });
    this.handleMsgEdit(event);
    return this.msgByIdMap.get(target.id);
  }

  /** Edit a specific own message (author-only, enforced by every consumer's handleMsgEdit). */
  async editMessage(channelId: string, communityId: string, targetId: string, text: string): Promise<Msg | undefined> {
    const target = this.msgByIdMap.get(targetId);
    if (!target || target.authorPk !== this.pubkey) return undefined;
    const event = await this.wire.publish({
      kind: K.MSG_EDIT,
      tags: [["e", targetId], ["h", channelId], ["c", communityId]],
      content: text,
    });
    this.handleMsgEdit(event);
    return this.msgByIdMap.get(targetId);
  }

  /** My own live reaction (its event id) on a target, if any — the toggle handle. */
  myReactionTo(targetId: string, emoji: string): string | undefined {
    for (const [reactionId, entry] of this.reactionIndex) {
      if (entry.targetId === targetId && entry.emoji === emoji && entry.authorPk === this.pubkey) return reactionId;
    }
    return undefined;
  }

  /** Toggle a reaction: publish kind 7, or retract my existing one via kind 5. */
  async toggleReaction(channelId: string, communityId: string, targetId: string, emoji: string): Promise<void> {
    const mine = this.myReactionTo(targetId, emoji);
    if (mine) {
      const event = await this.wire.publish({
        kind: K.DELETION,
        tags: [["e", mine], ["h", channelId], ["c", communityId]],
        content: "",
      });
      this.handleDeletion(event);
      return;
    }
    const event = await this.wire.publish({
      kind: K.REACTION,
      tags: [["e", targetId], ["h", channelId], ["c", communityId]],
      content: emoji,
    });
    this.handleReaction(event, true);
  }

  async pinMessage(channelId: string, communityId: string, targetId: string): Promise<void> {
    const event = await this.wire.publish({
      kind: K.MSG_PIN,
      tags: [["e", targetId], ["h", channelId], ["c", communityId]],
      content: "",
    });
    this.handleMsgPin(event);
  }

  async unpin(channelId: string, communityId: string, opId: string): Promise<void> {
    const event = await this.wire.publish({
      kind: K.DELETION,
      tags: [["e", opId], ["h", channelId], ["c", communityId]],
      content: "",
    });
    this.handleDeletion(event);
  }

  /**
   * Publish a kind-5 deletion for a channel message. The trust rule
   * (author-or-creator) is enforced on READ in handleDeletion by every
   * client — publishing without standing just produces an event everyone
   * ignores. Callers should still gate the UI on canDeleteMessage().
   */
  async deleteMessage(channelId: string, communityId: string, targetId: string): Promise<void> {
    const event = await this.wire.publish({
      kind: K.DELETION,
      tags: [["e", targetId], ["h", channelId], ["c", communityId]],
      content: "",
    });
    this.handleDeletion(event);
  }

  canDeleteMessage(communityId: string, msg: Msg): boolean {
    return msg.authorPk === this.pubkey || this.state.communities.get(communityId)?.creator === this.pubkey;
  }

  async bookmarkMessage(channelId: string, communityId: string, targetId: string): Promise<void> {
    const event = await this.wire.publish({
      kind: K.MSG_BOOKMARK,
      tags: [["e", targetId], ["h", channelId], ["c", communityId]],
      content: "",
    });
    this.handleMsgBookmark(event);
  }

  async scheduleMessage(channelId: string, communityId: string, sendAt: number, text: string): Promise<void> {
    await this.wire.publish({
      kind: K.SCHEDULED,
      tags: [["h", channelId], ["c", communityId], ["send_at", String(sendAt)]],
      content: text,
    });
  }

  /**
   * Reminders are private data on a public relay — note, fire time, and
   * subject all ride NIP-44 self-encrypted (Buzz built encrypted 30300
   * NIP-ER for exactly this reason; the plaintext remind_at tag was a
   * leak). The sentinel runs with this same key and decrypts to arm.
   */
  async setReminder(remindAt: number, note: string, aboutEventId?: string): Promise<void> {
    await this.wire.publish({
      kind: K.REMINDER,
      tags: [["p", this.pubkey]],
      content: this.wire.encrypt(
        this.pubkey,
        JSON.stringify({ note, remind_at: remindAt, ...(aboutEventId ? { about: aboutEventId } : {}) })
      ),
    });
  }

  async sendDm(peerPk: string, text: string): Promise<void> {
    const id = await this.wire.sendDm(peerPk, text);
    if (id) this.seenDmIds.add(id);
    const convo = this.dmConvo(peerPk);
    convo.msgs.push({ id, senderPk: this.pubkey, text, ts: Math.floor(Date.now() / 1000) });
  }

  /** Send into a group conversation (2+ other participants). */
  async sendGroupDm(recipientPks: string[], text: string): Promise<void> {
    if (!this.wire.sendGroupDm) throw new Error("this wire backend doesn't support group DMs");
    const id = await this.wire.sendGroupDm(recipientPks, text);
    if (id) this.seenDmIds.add(id);
    const participants = [...new Set([this.pubkey, ...recipientPks])].sort();
    const convo = this.dmConvo(dmConvoKey(participants, this.pubkey));
    convo.participants = participants;
    convo.msgs.push({ id, senderPk: this.pubkey, text, ts: Math.floor(Date.now() / 1000) });
  }

  /** Human-readable conversation title for a convo key ("alice + bob" for groups). */
  dmTitle(key: string): string {
    return key.split("+").map((pk) => this.displayName(pk)).join(" + ");
  }

  /** The other participants behind a convo key. */
  dmPeers(key: string): string[] {
    return key.split("+").filter(Boolean);
  }

  markDmRead(peerPk: string): void {
    this.dmConvo(peerPk).unread = 0;
  }

  /** Viewing a channel reads it; debounced self-encrypted 30078 syncs across sessions. */
  markRead(channelId: string, ts: number): void {
    if ((this.lastReadByChannel.get(channelId) ?? 0) >= ts) return;
    this.lastReadByChannel.set(channelId, ts);
    this.emit("unreadsChanged");
    clearTimeout(this.readPublishTimers.get(channelId));
    this.readPublishTimers.set(
      channelId,
      setTimeout(() => {
        void this.wire
          .publish({
            kind: K.READ_STATE,
            tags: [["d", channelId]],
            content: this.wire.encrypt(this.pubkey, JSON.stringify({ last_read: this.lastReadByChannel.get(channelId) })),
          })
          .catch(() => {});
      }, 5000)
    );
  }

  async docVersions(channelId: string, communityId: string): Promise<WireEvent[]> {
    const events = await this.wire.query([{ kinds: [K.DOC], "#h": [channelId], limit: 200 }]);
    return orderVersions(
      events
        .filter((e) => this.state.isMember(communityId, channelId, e.pubkey))
        .filter((e) => !e.tags.some((t) => t[0] === "d")) // named pages aren't the channel doc
    );
  }

  async publishDoc(channelId: string, communityId: string, content: string, baseId?: string): Promise<void> {
    await this.wire.publish({
      kind: K.DOC,
      tags: [["h", channelId], ["c", communityId], ...(baseId ? [["base", baseId]] : [])],
      content,
    });
  }

  /** Checkbox state for a doc — latest event per item wins. */
  async docTasks(communityId: string, opts: { channelId?: string; slug?: string }): Promise<Map<string, TaskState>> {
    const filter = opts.slug
      ? { kinds: [K.DOC_TASK], "#d": [opts.slug], limit: 500 }
      : { kinds: [K.DOC_TASK], "#h": [opts.channelId ?? ""], limit: 500 };
    const events = (await this.wire.query([filter])).filter(
      (e) => e.tags.some((t) => t[0] === "c" && t[1] === communityId) && this.state.isCommunityMember(communityId, e.pubkey)
    );
    const states = new Map<string, TaskState>();
    for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
      const key = event.tags.find((t) => t[0] === "t")?.[1];
      if (!key) continue;
      states.set(key, {
        done: event.tags.find((t) => t[0] === "done")?.[1] === "1",
        byPk: event.pubkey,
        ts: event.created_at,
      });
    }
    return states;
  }

  async setTaskDone(
    channelId: string,
    communityId: string,
    itemText: string,
    done: boolean,
    slug?: string
  ): Promise<void> {
    await this.wire.publish({
      kind: K.DOC_TASK,
      tags: [
        ["h", channelId],
        ["c", communityId],
        ...(slug ? [["d", slug]] : []),
        ["t", taskKey(itemText)],
        ["done", done ? "1" : "0"],
      ],
      content: "",
    });
  }

  /** Named wiki pages in joined communities, keyed `${communityId}:${slug}`. */
  wikiDocs(): ReadonlyMap<string, WikiDoc> {
    return this.wikiMap;
  }

  async wikiVersions(communityId: string, slug: string): Promise<WireEvent[]> {
    const events = await this.wire.query([{ kinds: [K.DOC], "#d": [slug], limit: 200 }]);
    return orderVersions(
      events
        .filter((e) => e.tags.some((t) => t[0] === "c" && t[1] === communityId))
        // community-scoped: a page belongs to the community, not to the
        // channel it happened to be written from
        .filter((e) => this.state.isCommunityMember(communityId, e.pubkey))
    );
  }

  /**
   * Comments on a doc/page, anchored by LINE TEXT (not line number) so a
   * note stays attached when lines shift above it. Returns threads:
   * a root comment plus its replies, with resolution folded in.
   */
  async docComments(communityId: string, opts: { channelId?: string; slug?: string }): Promise<DocCommentThread[]> {
    const filter = opts.slug
      ? { kinds: [K.DOC_COMMENT], "#d": [opts.slug], limit: 500 }
      : { kinds: [K.DOC_COMMENT], "#h": [opts.channelId ?? ""], limit: 500 };
    const events = (await this.wire.query([filter])).filter(
      (e) => e.tags.some((t) => t[0] === "c" && t[1] === communityId) && this.state.isCommunityMember(communityId, e.pubkey)
    );
    const roots = new Map<string, DocCommentThread>();
    const replies: WireEvent[] = [];
    const resolvedRoots = new Set<string>();
    for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
      const parent = event.tags.find((t) => t[0] === "e")?.[1];
      if (event.tags.some((t) => t[0] === "resolved" && t[1] === "1")) {
        if (parent) resolvedRoots.add(parent);
        if (!event.content.trim()) continue; // pure resolve marker
      }
      if (parent) replies.push(event);
      else {
        roots.set(event.id, {
          id: event.id,
          anchor: event.tags.find((t) => t[0] === "anchor")?.[1] ?? "",
          authorPk: event.pubkey,
          text: event.content,
          ts: event.created_at,
          resolved: false,
          replies: [],
        });
      }
    }
    for (const reply of replies) {
      const root = roots.get(reply.tags.find((t) => t[0] === "e")![1]);
      if (root) root.replies.push({ id: reply.id, authorPk: reply.pubkey, text: reply.content, ts: reply.created_at });
    }
    for (const id of resolvedRoots) {
      const root = roots.get(id);
      if (root) root.resolved = true;
    }
    return [...roots.values()].sort((a, b) => a.ts - b.ts);
  }

  /** Leave a comment (or reply). Mentions are p-tagged so agents get summoned. */
  async publishDocComment(
    channelId: string,
    communityId: string,
    text: string,
    opts: { anchor?: string; slug?: string; parentId?: string; mentionPks?: string[]; resolve?: boolean } = {}
  ): Promise<void> {
    await this.wire.publish({
      kind: K.DOC_COMMENT,
      tags: [
        ["h", channelId],
        ["c", communityId],
        ...(opts.slug ? [["d", opts.slug]] : []),
        ...(opts.anchor ? [["anchor", opts.anchor.slice(0, 300)]] : []),
        ...(opts.parentId ? [["e", opts.parentId]] : []),
        ...(opts.resolve ? [["resolved", "1"]] : []),
        ...(opts.mentionPks ?? []).map((pk) => ["p", pk]),
      ],
      content: text,
    });
  }

  async publishWikiDoc(channelId: string, communityId: string, name: string, content: string, baseId?: string): Promise<void> {
    const slug = wikiSlug(name);
    if (!slug) throw new Error(`"${name}" makes an empty page name`);
    await this.wire.publish({
      kind: K.DOC,
      tags: [
        ["h", channelId],
        ["c", communityId],
        ["d", slug],
        ["title", name.trim()],
        ...(baseId ? [["base", baseId]] : []),
      ],
      content,
    });
  }

  async createCommunity(name: string): Promise<{ communityId: string; channelId: string }> {
    const communityId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    await this.wire.publish({ kind: K.COMMUNITY, tags: [["d", communityId]], content: JSON.stringify({ name }) });
    await this.wire.publish({
      kind: K.CHANNEL,
      tags: [["d", channelId], ["c", communityId]],
      content: JSON.stringify({ name: "general", visibility: "open" }),
    });
    await this.wire.publish({
      kind: K.MEMBERSHIP,
      tags: [["d", channelId], ["c", communityId], ["p", this.pubkey, "owner"]],
      content: "",
    });
    this.state.joined.add(communityId);
    this.state.scope = { communityId, channelId };
    this.state.save();
    await this.syncJoined();
    this.resubscribe();
    return { communityId, channelId };
  }

  /** Creator adds a channel to their community; scope moves there. */
  async createChannel(communityId: string, name: string): Promise<string> {
    const community = this.state.communities.get(communityId);
    if (!community) throw new Error("unknown community");
    if (community.creator !== this.pubkey) throw new Error("only the community creator can add channels (v1)");
    const channelId = crypto.randomUUID();
    const channelEvent = await this.wire.publish({
      kind: K.CHANNEL,
      tags: [["d", channelId], ["c", communityId]],
      content: JSON.stringify({ name, visibility: "open" }),
    });
    const rosterEvent = await this.wire.publish({
      kind: K.MEMBERSHIP,
      tags: [["d", channelId], ["c", communityId], ["p", this.pubkey, "owner"]],
      content: "",
    });
    this.state.absorb(channelEvent);
    this.state.absorb(rosterEvent);
    this.state.scope = { communityId, channelId };
    this.state.save();
    this.resubscribe();
    this.emit("channelsChanged");
    return channelId;
  }

  async listCommunities(): Promise<{ id: string; name: string; joined: boolean }[]> {
    const events = await this.wire.query([{ kinds: [K.COMMUNITY], limit: 50 }]);
    for (const e of events) this.state.absorb(e);
    return [...this.state.communities.values()].map((c) => ({ id: c.id, name: c.name, joined: this.state.joined.has(c.id) }));
  }

  async joinCommunity(communityId: string): Promise<boolean> {
    this.state.joined.add(communityId);
    this.state.save();
    await this.syncJoined();
    this.resubscribe();
    return this.state.community(communityId) !== undefined;
  }

  /** Scope to a channel by name across joined communities; loads its history window. */
  async joinChannel(name: string): Promise<{ communityId: string; channelId: string; name: string } | undefined> {
    for (const communityId of this.state.joined) {
      const channel = this.state.findChannelByName(communityId, name);
      if (channel) {
        this.state.scope = { communityId, channelId: channel.id };
        this.state.save();
        this.emit("channelsChanged");
        await this.loadChannelHistory(channel.id, communityId);
        return { communityId, channelId: channel.id, name: channel.name };
      }
    }
    return undefined;
  }

  leaveScope(): void {
    this.state.scope = null;
    this.state.save();
    this.emit("channelsChanged");
  }

  /**
   * Leave a community: stop subscribing to its channels and drop it from
   * the sidebar. Purely local — nothing is published; the roster still
   * lists you (only the creator edits rosters), and re-joining restores
   * everything from the relay. The community itself is untouched.
   */
  leaveCommunity(communityId: string): void {
    if (!this.state.joined.delete(communityId)) return;
    if (this.state.scope?.communityId === communityId) this.state.scope = null;
    this.state.save();
    this.resubscribe(); // shed the left channels from the live filters
    this.emit("channelsChanged");
  }

  setScope(communityId: string, channelId: string): void {
    this.state.scope = { communityId, channelId };
    this.state.save();
    this.emit("channelsChanged");
  }

  /**
   * Roster updates must strictly advance the winning 47102's created_at —
   * two updates in the same second would otherwise tie and resolve by id,
   * surprising the creator who published second (Buzz bumps for the same
   * reason).
   */
  private nextRosterCreatedAt(channel: { membershipCreatedAt: number }): number {
    return Math.max(Math.floor(Date.now() / 1000), channel.membershipCreatedAt + 1);
  }

  async invite(pubkey: string, role: Role): Promise<string> {
    const current = this.state.currentChannel();
    if (!current) throw new Error("no channel scope");
    if (current.community.creator !== this.pubkey) throw new Error("only the community creator can invite (v1)");
    const tags: string[][] = [
      ["d", current.channel.id],
      ["c", current.community.id],
      ...[...current.channel.members.entries()].map(([pk, r]) => ["p", pk, r]),
    ];
    if (!current.channel.members.has(pubkey)) tags.push(["p", pubkey, role]);
    const event = await this.wire.publish({
      kind: K.MEMBERSHIP,
      tags,
      content: "",
      created_at: this.nextRosterCreatedAt(current.channel),
    });
    this.state.absorb(event);
    this.emit("channelsChanged");
    return this.displayName(pubkey);
  }

  /**
   * Ban/unban (creator-only): republish the community's 30047 with the
   * pubkey added/removed, created_at strictly advancing (same monotonic
   * rule as rosters). A ban leaves the roster untouched — the banned
   * pubkey is simply treated as a non-member everywhere until unbanned.
   */
  private async publishBanList(communityId: string, banned: Set<string>): Promise<void> {
    const community = this.state.communities.get(communityId);
    if (!community) throw new Error("unknown community");
    if (community.creator !== this.pubkey) throw new Error("only the community creator can moderate");
    const event = await this.wire.publish({
      kind: K.BAN_LIST,
      tags: [["d", communityId], ...[...banned].map((pk) => ["p", pk])],
      content: "",
      created_at: Math.max(Math.floor(Date.now() / 1000), community.banListCreatedAt + 1),
    });
    this.state.absorb(event);
    this.emit("channelsChanged");
  }

  async banUser(communityId: string, pubkey: string): Promise<string> {
    const community = this.state.communities.get(communityId);
    if (community && pubkey === community.creator) throw new Error("the creator can't be banned");
    const banned = new Set(community?.banned ?? []);
    banned.add(pubkey);
    await this.publishBanList(communityId, banned);
    return this.displayName(pubkey);
  }

  async unbanUser(communityId: string, pubkey: string): Promise<string> {
    const banned = new Set(this.state.communities.get(communityId)?.banned ?? []);
    if (!banned.delete(pubkey)) throw new Error("not banned");
    await this.publishBanList(communityId, banned);
    return this.displayName(pubkey);
  }

  /** Creator republishes the roster without the pubkey. The removed party's history stays. */
  async kick(pubkey: string): Promise<string> {
    const current = this.state.currentChannel();
    if (!current) throw new Error("no channel scope");
    if (current.community.creator !== this.pubkey) throw new Error("only the community creator can remove members");
    if (pubkey === current.community.creator) throw new Error("the creator can't be removed — the roster is rooted in their signature");
    if (!current.channel.members.has(pubkey)) throw new Error("not a member of this channel");
    const tags: string[][] = [
      ["d", current.channel.id],
      ["c", current.community.id],
      ...[...current.channel.members.entries()].filter(([pk]) => pk !== pubkey).map(([pk, r]) => ["p", pk, r]),
    ];
    const event = await this.wire.publish({
      kind: K.MEMBERSHIP,
      tags,
      content: "",
      created_at: this.nextRosterCreatedAt(current.channel),
    });
    this.state.absorb(event);
    this.emit("channelsChanged");
    return this.displayName(pubkey);
  }

  async queryEngrams(agentPk: string): Promise<WireEvent[]> {
    return this.wire.query([{ kinds: [30174], authors: [agentPk], "#p": [this.pubkey] }]);
  }
  decryptFrom(peerPk: string, ciphertext: string): string {
    return this.wire.decrypt(peerPk, ciphertext);
  }

  // ── History windows (Buzz's channel window, dumb-relay-shaped) ─────────

  async loadChannelHistory(channelId: string, communityId: string): Promise<void> {
    // Artifacts backfill rides alongside — failures never block messages.
    void this.wire
      .query([{ kinds: [K.ARTIFACT], "#h": [channelId], limit: 50 }])
      .then((events) => {
        for (const event of events) this.absorbArtifact(event);
      })
      .catch(() => {});
    const [msgs, reactions, deletions, ops] = await Promise.all([
      this.wire.query([{ kinds: [K.MESSAGE], "#h": [channelId], limit: 200 }]),
      this.wire.query([{ kinds: [K.REACTION], "#h": [channelId], limit: 300 }]),
      this.wire.query([{ kinds: [K.DELETION], "#h": [channelId], limit: 300 }]),
      this.wire.query([{ kinds: [K.MSG_EDIT, K.MSG_PIN, K.MSG_BOOKMARK], "#h": [channelId], limit: 300 }]),
    ]);
    const ordered = msgs
      .filter((e) => this.state.isMember(communityId, channelId, e.pubkey))
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-HISTORY_LIMIT);
    for (const event of ordered) {
      if (this.seenMessages.has(event.id)) continue;
      this.seenMessages.add(event.id);
      const msg = this.cacheMessage(channelId, event);
      this.emit("message", channelId, msg, { live: false, prepend: false });
    }
    for (const event of ops.filter((e) => e.kind === K.MSG_EDIT).sort((a, b) => a.created_at - b.created_at)) {
      this.handleMsgEdit(event);
    }
    for (const event of reactions.sort((a, b) => a.created_at - b.created_at)) this.handleReaction(event, false);
    for (const event of ops) {
      if (event.kind === K.MSG_PIN) this.handleMsgPin(event);
      else if (event.kind === K.MSG_BOOKMARK) this.handleMsgBookmark(event);
    }
    for (const event of deletions) this.handleDeletion(event);
    if (this.state.scope?.channelId === channelId) {
      const newest = (this.messagesByChannel.get(channelId) ?? []).at(-1);
      if (newest) this.markRead(channelId, newest.ts);
    }
    this.emit("unreadsChanged");
  }

  /** Scroll-up paging: until-filter keyset with limit+1 has_more probe. Returns the fresh page, oldest first. */
  async loadOlderPage(channelId: string, communityId: string): Promise<Msg[]> {
    const list = this.messagesByChannel.get(channelId) ?? [];
    const oldest = list[0]?.ts;
    if (!oldest || this.exhaustedChannels.has(channelId)) return [];
    const events = await this.wire.query([
      { kinds: [K.MESSAGE], "#h": [channelId], until: oldest, limit: PAGE_SIZE + 1 },
    ]);
    if (events.length <= PAGE_SIZE) this.exhaustedChannels.add(channelId);
    const fresh = events
      .filter((e) => !this.seenMessages.has(e.id) && this.state.isMember(communityId, channelId, e.pubkey))
      .sort((a, b) => a.created_at - b.created_at);
    if (fresh.length === 0) this.exhaustedChannels.add(channelId);
    const freshMsgs: Msg[] = [];
    for (const event of fresh) {
      this.seenMessages.add(event.id);
      const msg = this.buildMsg(event);
      freshMsgs.push(msg);
      this.msgByIdMap.set(msg.id, msg);
      if (msg.rootId) this.threadNo(msg.rootId);
    }
    this.messagesByChannel.set(channelId, [...freshMsgs, ...list].slice(-MSG_CACHE_CAP));
    return freshMsgs;
  }

  // ── Startup ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.state.load();

    // Always-on, channel-orthogonal subscriptions.
    this.wire.subscribe([{ kinds: [K.OBSERVER], "#p": [this.pubkey] }], (e) => this.handleObserverFrame(e));
    this.wire.subscribe(
      [{ kinds: [K.GIFT_WRAP], "#p": [this.pubkey], since: this.sessionStartS - DM_FUZZ_WINDOW_S }],
      (e) => this.handleGiftWrap(e)
    );
    this.wire.subscribe([{ kinds: [K.PRESENCE] }], (e) => {
      this.lastSeenByPk.set(e.pubkey, Date.now());
    });
    const beat = () => void this.wire.publish({ kind: K.PRESENCE, tags: [], content: "{}" }).catch(() => {});
    beat();
    setInterval(() => {
      beat();
      this.emit("presenceChanged");
    }, PRESENCE_BEAT_MS).unref?.();
    setInterval(() => this.emit("typingChanged"), 1000).unref?.();

    // Names roster: agent announcements + human kind-0 profiles + status.
    try {
      const [metadataEvents, profileEvents, statusEvents] = await Promise.all([
        // Same 7-day window as the live subscription below — without it the
        // boot query resurrects every agent that EVER announced (found live:
        // throwaway test agents from days ago haunting the roster forever).
        this.wire.query([{ kinds: [K.AGENT_METADATA], since: Math.floor(Date.now() / 1000) - 7 * 86400, limit: 200 }]),
        this.wire.query([{ kinds: [K.PROFILE], limit: 200 }]),
        this.wire.query([{ kinds: [K.USER_STATUS], limit: 200 }]),
      ]);
      for (const event of metadataEvents) this.absorbName(event, false);
      for (const event of profileEvents) this.absorbProfile(event, false);
      for (const event of statusEvents) this.absorbStatus(event, false);
      this.emit("presenceChanged");
    } catch { /* roster fills from the live stream */ }
    this.wire.subscribe(
      [{ kinds: [K.PROFILE, K.USER_STATUS], since: Math.floor(Date.now() / 1000) }],
      (e) => (e.kind === K.PROFILE ? this.absorbProfile(e) : this.absorbStatus(e))
    );

    // Read state (before history so unreads count against synced marks).
    try {
      const readEvents = await this.wire.query([{ kinds: [K.READ_STATE], authors: [this.pubkey] }]);
      const latestByD = new Map<string, WireEvent>();
      for (const event of readEvents) {
        const d = event.tags.find((t) => t[0] === "d")?.[1];
        if (!d) continue;
        const prev = latestByD.get(d);
        if (!prev || event.created_at > prev.created_at) latestByD.set(d, event);
      }
      for (const [d, event] of latestByD) {
        try {
          this.lastReadByChannel.set(d, Number(JSON.parse(this.wire.decrypt(this.pubkey, event.content)).last_read) || 0);
        } catch { /* not ours / old format */ }
      }
    } catch { /* badges start from zero */ }

    // Before concluding anyone is new, ask the relay. A cache miss is
    // not evidence of a first run — it's the most common way an
    // existing user arrives.
    if (this.state.joined.size === 0) {
      const recovered = await this.recoverJoined();
      if (recovered > 0) {
        this.emit(
          "notice",
          `🔑 Recovered ${recovered} ${recovered === 1 ? "community" : "communities"} from your membership on the relay.`
        );
      }
    }

    // First-run bootstrap: a brand-new user lands in a working room.
    if (this.state.joined.size === 0 && !this.state.persistedFileExists()) {
      try {
        const { communityId, channelId } = await this.createCommunity("Home");
        this.state.scope = { communityId, channelId };
        this.state.save();
        this.emit("notice", "🏠 Created your Home community — you're in #general. Mention an agent (@researcher …) to get going; /help for the rest.");
      } catch { /* relay unreachable — host surfaces connection errors */ }
    }

    await this.syncJoined();
    this.resubscribe();

    // Docs hydrate.
    try {
      const docEvents = await this.wire.query([{ kinds: [K.DOC], "#h": this.channelIdsOfJoined(), limit: 500 }]);
      for (const event of docEvents) this.absorbDocEvent(event);
    } catch { /* live stream fills in */ }

    const scope = this.state.scope;
    if (scope) await this.loadChannelHistory(scope.channelId, scope.communityId);
    this.emit("channelsChanged");
  }

  // ── Internal machinery (ported 1:1 from the communities extension) ─────

  private buildMsg(event: WireEvent): Msg {
    const parentId = event.tags.filter((t) => t[0] === "e" && t[3] === "reply").at(-1)?.[1];
    const rootId = event.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? parentId;
    return {
      id: event.id,
      authorPk: event.pubkey,
      authorName: this.displayName(event.pubkey),
      content: event.content,
      parentId,
      rootId,
      ts: event.created_at,
    };
  }

  private cacheMessage(channelId: string, event: WireEvent): Msg {
    const msg = this.buildMsg(event);
    const list = this.messagesByChannel.get(channelId) ?? [];
    list.push(msg);
    if (list.length > MSG_CACHE_CAP) list.splice(0, list.length - MSG_CACHE_CAP);
    this.messagesByChannel.set(channelId, list);
    this.msgByIdMap.set(msg.id, msg);
    if (msg.rootId) this.threadNo(msg.rootId);
    return msg;
  }

  private dmConvo(key: string): { msgs: DmMessage[]; unread: number; participants?: string[] } {
    let convo = this.dmConvos.get(key);
    if (!convo) this.dmConvos.set(key, (convo = { msgs: [], unread: 0 }));
    return convo;
  }

  private profileTs = new Map<string, number>();
  private statusTs = new Map<string, number>();

  /** Kind-0 profile: self-attested display name (latest per pubkey wins). */
  private absorbProfile(event: WireEvent, emitChange = true): void {
    if (event.created_at < (this.profileTs.get(event.pubkey) ?? 0)) return;
    try {
      const meta = JSON.parse(event.content) as { name?: string; display_name?: string };
      const name = (meta.display_name || meta.name || "").trim().slice(0, 48);
      if (!name) return;
      this.profileTs.set(event.pubkey, event.created_at);
      if (this.profiles.get(event.pubkey) !== name) {
        this.profiles.set(event.pubkey, name);
        if (emitChange) this.emit("presenceChanged");
      }
    } catch { /* not a profile we can read */ }
  }

  /** Kind-30315 user status: free-text ("away", "deep work"); empty clears. */
  private absorbStatus(event: WireEvent, emitChange = true): void {
    if (event.created_at < (this.statusTs.get(event.pubkey) ?? 0)) return;
    this.statusTs.set(event.pubkey, event.created_at);
    const text = event.content.trim().slice(0, 80);
    if (text) this.statuses.set(event.pubkey, text);
    else this.statuses.delete(event.pubkey);
    if (emitChange) this.emit("presenceChanged");
  }

  /** Publish your kind-0 profile — humans get names, not hex. */
  async setProfile(name: string): Promise<void> {
    const event = await this.wire.publish({ kind: K.PROFILE, tags: [], content: JSON.stringify({ name }) });
    this.absorbProfile(event);
  }

  /** Publish (or clear, with empty text) your kind-30315 status. */
  async setStatus(text: string): Promise<void> {
    const event = await this.wire.publish({
      kind: K.USER_STATUS,
      tags: [["d", "general"]],
      content: text,
    });
    this.absorbStatus(event);
  }

  private absorbName(event: WireEvent, emitChange = true): void {
    try {
      const meta = JSON.parse(event.content) as { name?: string; about?: string; skills?: unknown };
      if (meta.name && this.names.get(event.pubkey) !== meta.name) {
        this.names.set(event.pubkey, meta.name);
        if (emitChange) this.emit("presenceChanged");
      }
      if (meta.name) {
        this.agentMeta.set(event.pubkey, {
          about: typeof meta.about === "string" ? meta.about : undefined,
          skills: Array.isArray(meta.skills) ? meta.skills.filter((s): s is string => typeof s === "string") : undefined,
        });
      }
    } catch { /* ignore */ }
  }

  private channelIdsOfJoined(): string[] {
    const ids: string[] = [];
    for (const communityId of this.state.joined) {
      const community = this.state.community(communityId);
      if (community) ids.push(...community.channels.keys());
    }
    return ids;
  }

  /**
   * Rebuild "which communities am I in" from the relay.
   *
   * Membership is a signed event naming your pubkey. Local state is a
   * CACHE of that, and treating the cache as the record is how a client
   * loses your communities for good: clear a browser's storage, move to
   * a second device, reinstall the app, and the client concludes you
   * belong nowhere — then the first-run bootstrap helpfully makes you a
   * brand-new empty "Home" while every document you have ever written
   * sits on the relay, addressed to a community you are still a member
   * of. Four "Home" communities on one relay is what that looks like
   * after it happens a few times.
   *
   * Removal has to be honoured, which is the whole subtlety: a
   * membership event is replaceable per channel, so being p-tagged by
   * SOME version is not the same as being a member now. Candidates come
   * from events that ever named us; each is then confirmed against the
   * LATEST membership for that channel. Silently rejoining a community
   * you were removed from would be a worse bug than the one this fixes.
   */
  private async recoverJoined(): Promise<number> {
    let candidates: WireEvent[];
    try {
      candidates = await this.wire.query([{ kinds: [K.MEMBERSHIP], "#p": [this.pubkey], limit: 500 }]);
    } catch {
      return 0; // relay unreachable — the caller keeps whatever cache it has
    }
    const channelIds = [...new Set(candidates.map((e) => e.tags.find((t) => t[0] === "d")?.[1]).filter(Boolean))] as string[];
    if (channelIds.length === 0) return 0;

    // Latest membership per channel, unfiltered by p — the current roll.
    const rolls = await this.wire.query([{ kinds: [K.MEMBERSHIP], "#d": channelIds, limit: 1000 }]);
    const latest = new Map<string, WireEvent>();
    for (const event of rolls) {
      const channelId = event.tags.find((t) => t[0] === "d")?.[1];
      if (!channelId) continue;
      const current = latest.get(channelId);
      if (!current || event.created_at > current.created_at) latest.set(channelId, event);
    }

    const recovered = new Set<string>();
    for (const event of latest.values()) {
      if (!event.tags.some((t) => t[0] === "p" && t[1] === this.pubkey)) continue; // removed since
      const communityId = event.tags.find((t) => t[0] === "c")?.[1];
      if (communityId) recovered.add(communityId);
    }
    for (const communityId of recovered) this.state.joined.add(communityId);
    if (recovered.size > 0) this.state.save();
    return recovered.size;
  }

  private async syncJoined(): Promise<void> {
    const ids = [...this.state.joined];
    if (ids.length === 0) return;
    const events = await this.wire.query([
      { kinds: [K.COMMUNITY], "#d": ids },
      { kinds: [K.CHANNEL, K.MEMBERSHIP], "#c": ids },
      { kinds: [K.BAN_LIST], "#d": ids },
    ]);
    for (const kind of [K.COMMUNITY, K.CHANNEL, K.MEMBERSHIP, K.BAN_LIST]) {
      for (const event of events.filter((e) => e.kind === kind)) this.state.absorb(event);
    }
    this.emit("channelsChanged");
  }

  private resubscribe(): void {
    this.unsubscribeLive?.();
    this.subscribedChannelIds = this.channelIdsOfJoined().sort().join(",");
    const ids = [...this.state.joined];
    const filters: WireFilter[] = [{ kinds: [K.AGENT_METADATA], since: Math.floor(Date.now() / 1000) - 7 * 86400 }];
    if (ids.length > 0) {
      filters.push(
        { kinds: [K.COMMUNITY, K.CHANNEL, K.MEMBERSHIP], "#c": ids },
        { kinds: [K.COMMUNITY, K.BAN_LIST], "#d": ids },
        {
          kinds: [K.MESSAGE, K.TYPING, K.REACTION, K.DELETION, K.DRAFT, K.WORKFLOW_RUN, K.DOC, K.MSG_EDIT, K.MSG_PIN, K.MSG_BOOKMARK, K.ARTIFACT],
          "#h": this.channelIdsOfJoined(),
          since: Math.floor(Date.now() / 1000),
        },
        { kinds: [K.THREAD_SUMMARY], "#h": this.channelIdsOfJoined() }
      );
    }
    this.unsubscribeLive = this.wire.subscribe(filters, (event) => this.dispatch(event));
  }

  private dispatch(event: WireEvent): void {
    switch (event.kind) {
      case K.TYPING: return this.handleTyping(event);
      case K.WORKFLOW_RUN: return this.handleWorkflowRun(event);
      case K.THREAD_SUMMARY: return this.handleThreadSummary(event);
      case K.REACTION: return this.handleReaction(event, true);
      case K.DELETION: return this.handleDeletion(event);
      case K.DRAFT: return this.handleDraft(event);
      case K.MSG_EDIT: return this.handleMsgEdit(event);
      case K.MSG_PIN: return this.handleMsgPin(event);
      case K.MSG_BOOKMARK: return this.handleMsgBookmark(event);
      case K.DOC: return this.handleDocEvent(event);
      case K.ARTIFACT: return this.absorbArtifact(event);
      case K.AGENT_METADATA: return this.absorbName(event);
      case K.MESSAGE: return this.handleIncomingMessage(event);
      default: {
        this.state.absorb(event);
        if (event.kind === K.CHANNEL) {
          const ids = this.channelIdsOfJoined().sort().join(",");
          // Resubscribe ONLY when the channel set changed — replayed
          // 47101s once fed a resubscribe feedback loop pinning the TUI
          // at 98% CPU.
          if (ids !== this.subscribedChannelIds) this.resubscribe();
        }
        this.emit("channelsChanged");
      }
    }
  }

  private handleIncomingMessage(event: WireEvent): void {
    if (this.seenMessages.has(event.id)) return;
    this.seenMessages.add(event.id);
    for (const key of this.typing.keys()) if (key.startsWith(`${event.pubkey}:`)) this.typing.delete(key);
    this.emit("typingChanged");
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId) return;
    if (!this.state.isMember(communityId, channelId, event.pubkey)) return;

    const msg = this.cacheMessage(channelId, event);

    // A threaded reply closes its author's job on the message it answers.
    if (msg.parentId) {
      for (const anchor of [msg.parentId, msg.rootId]) {
        const job = anchor ? this.jobsMap.get(`${event.pubkey}:${anchor}`) : undefined;
        if (job && job.status !== "done") {
          job.status = "done";
          job.endedAt = event.created_at * 1000;
          job.currentTool = undefined;
          this.emit("jobsChanged");
          break;
        }
      }
    }

    if (this.state.scope?.channelId === channelId) this.markRead(channelId, msg.ts);
    else this.emit("unreadsChanged");

    this.emit("message", channelId, msg, { live: true, prepend: false });
    if (msg.rootId) this.emit("metaChanged", channelId, msg.rootId);
  }

  private handleReaction(event: WireEvent, live: boolean): void {
    const targetId = event.tags.find((t) => t[0] === "e")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!targetId || !channelId || !communityId) return;
    if (!this.state.isMember(communityId, channelId, event.pubkey)) return;
    const emoji = event.content.trim();
    if (!emoji || emoji.length > 8) return;
    let byEmoji = this.reactionsByTarget.get(targetId);
    if (!byEmoji) this.reactionsByTarget.set(targetId, (byEmoji = new Map()));
    let who = byEmoji.get(emoji);
    if (!who) byEmoji.set(emoji, (who = new Set()));
    who.add(this.displayName(event.pubkey));
    this.reactionIndex.set(event.id, { targetId, emoji, authorPk: event.pubkey });
    this.emit("reaction", channelId, targetId);

    // Status reactions open jobs (👀 accepted / 💬 working) — live only:
    // a stored 👀 from last week is history, not an active turn.
    if (live && (emoji === "👀" || emoji === "💬")) {
      const key = `${event.pubkey}:${targetId}`;
      const existing = this.jobsMap.get(key);
      if (existing) {
        if (emoji === "💬" && existing.status !== "working" && existing.status !== "done") {
          existing.status = "working";
          this.emit("jobsChanged");
        }
      } else {
        const trigger = this.msgByIdMap.get(targetId);
        this.jobsMap.set(key, {
          triggerId: targetId,
          agentPk: event.pubkey,
          channelId,
          status: emoji === "💬" ? "working" : "seen",
          startedAt: event.created_at * 1000,
          rootId: trigger?.rootId ?? targetId,
          snippet: (trigger?.content ?? "(message not seen)").replace(/\s+/g, " ").slice(0, 48),
        });
        while (this.jobsMap.size > JOB_CAP) this.jobsMap.delete(this.jobsMap.keys().next().value as string);
        this.emit("jobsChanged");
      }
    }
  }

  private handleDeletion(event: WireEvent): void {
    for (const tag of event.tags) {
      if (tag[0] !== "e" || !tag[1]) continue;
      const op = this.opIndex.get(tag[1]);
      if (op && op.by === event.pubkey) {
        this.opIndex.delete(tag[1]);
        if (op.type === "pin") {
          this.pinsByChannel.get(op.channelId)?.delete(op.targetId);
          this.emit("metaChanged", op.channelId, op.targetId);
        } else {
          this.myBookmarksMap.delete(op.targetId);
        }
        continue;
      }
      const entry = this.reactionIndex.get(tag[1]);
      if (entry && entry.authorPk === event.pubkey) {
        this.reactionIndex.delete(tag[1]);
        const who = this.reactionsByTarget.get(entry.targetId)?.get(entry.emoji);
        who?.delete(this.displayName(entry.authorPk));
        if (who && who.size === 0) this.reactionsByTarget.get(entry.targetId)?.delete(entry.emoji);
        const channelId = event.tags.find((t) => t[0] === "h")?.[1] ?? "";
        this.emit("reaction", channelId, entry.targetId);
        continue;
      }

      // Channel messages tombstone under the trust rule: the author may
      // delete their own; the community creator may delete anyone's (the
      // moderation analog — same authority that signs the roster). Anyone
      // else's kind 5 is ignored. The tombstone stays visible ("removed
      // by …"), never a silent hole.
      const msg = this.msgByIdMap.get(tag[1]);
      if (!msg || msg.deletedBy) continue;
      const channelId =
        event.tags.find((t) => t[0] === "h")?.[1] ?? this.channelOfMessage(tag[1]);
      if (!channelId) continue;
      const isAuthor = event.pubkey === msg.authorPk;
      const communityId =
        event.tags.find((t) => t[0] === "c")?.[1] ?? this.state.communityOfChannel(channelId);
      const isCreator =
        communityId !== undefined && this.state.communities.get(communityId)?.creator === event.pubkey;
      if (!isAuthor && !isCreator) continue;
      msg.deletedBy = isAuthor ? "author" : "moderator";
      msg.content = "";
      this.emit("messageDeleted", channelId, msg);
      this.emit("metaChanged", channelId, msg.id);
    }
  }

  private channelOfMessage(msgId: string): string | undefined {
    for (const [channelId, list] of this.messagesByChannel) {
      if (list.some((m) => m.id === msgId)) return channelId;
    }
    return undefined;
  }

  private handleMsgEdit(event: WireEvent): void {
    const targetId = event.tags.find((t) => t[0] === "e")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!targetId || !channelId) return;
    const target = this.msgByIdMap.get(targetId);
    if (!target || event.pubkey !== target.authorPk) return; // author-only
    if (event.created_at < (target.editTs ?? 0)) return; // latest edit wins
    target.content = event.content;
    target.edited = true;
    target.editTs = event.created_at;
    this.emit("messageEdited", channelId, target);
    this.emit("metaChanged", channelId, targetId);
  }

  private handleMsgPin(event: WireEvent): void {
    const targetId = event.tags.find((t) => t[0] === "e")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!targetId || !channelId || !communityId) return;
    if (!this.state.isMember(communityId, channelId, event.pubkey)) return;
    let pins = this.pinsByChannel.get(channelId);
    if (!pins) this.pinsByChannel.set(channelId, (pins = new Map()));
    pins.set(targetId, { opId: event.id, by: event.pubkey, ts: event.created_at });
    this.opIndex.set(event.id, { type: "pin", channelId, targetId, by: event.pubkey });
    this.emit("metaChanged", channelId, targetId);
  }

  private handleMsgBookmark(event: WireEvent): void {
    if (event.pubkey !== this.pubkey) return;
    const targetId = event.tags.find((t) => t[0] === "e")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1] ?? "";
    if (!targetId) return;
    this.myBookmarksMap.set(targetId, { opId: event.id, ts: event.created_at, channelId });
    this.opIndex.set(event.id, { type: "bookmark", channelId, targetId, by: event.pubkey });
  }

  private handleThreadSummary(event: WireEvent): void {
    const rootId = event.tags.find((t) => t[0] === "d")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!rootId || !channelId || !communityId) return;
    if (!this.state.isMember(communityId, channelId, event.pubkey)) return;
    const existing = this.summaryByRoot.get(rootId);
    if (existing && event.created_at < existing.summaryTs) return;
    try {
      const { replyCount, lastReplyAt } = JSON.parse(event.content);
      if (typeof replyCount !== "number") return;
      this.summaryByRoot.set(rootId, { replyCount, lastAuthorTs: lastReplyAt ?? 0, summaryTs: event.created_at });
      this.threadNo(rootId);
      this.emit("metaChanged", channelId, rootId);
    } catch { /* malformed summary */ }
  }

  private handleTyping(event: WireEvent): void {
    if (event.pubkey === this.pubkey) return;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId || this.state.scope?.channelId !== channelId) return;
    const rootId =
      event.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ??
      event.tags.filter((t) => t[0] === "e" && t[3] === "reply").at(-1)?.[1];
    this.typing.set(`${event.pubkey}:${rootId ?? "channel"}`, {
      pubkey: event.pubkey,
      threadRoot: rootId,
      expiry: Date.now() + TYPING_TTL_MS,
    });
    this.emit("typingChanged");
  }

  private handleDraft(event: WireEvent): void {
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId || !event.content) return;
    if (event.pubkey === this.pubkey) return;
    if (!this.state.isMember(communityId, channelId, event.pubkey)) return;
    const rootId =
      event.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ??
      event.tags.filter((t) => t[0] === "e" && t[3] === "reply").at(-1)?.[1];
    // Streaming text supersedes the typing indicator for this author.
    for (const key of this.typing.keys()) if (key.startsWith(`${event.pubkey}:`)) this.typing.delete(key);
    this.emit("typingChanged");
    this.emit("draft", channelId, event.pubkey, event.content, rootId);
  }

  private handleWorkflowRun(event: WireEvent): void {
    try {
      const trace = JSON.parse(event.content) as { workflow?: string; run?: string; status?: string; step?: number };
      if (!trace.workflow || !trace.run || !trace.status) return;
      this.workflowRunsMap.set(trace.run, { workflow: trace.workflow, status: trace.status, step: trace.step, ts: event.created_at * 1000 });
      while (this.workflowRunsMap.size > 50) this.workflowRunsMap.delete(this.workflowRunsMap.keys().next().value as string);
      this.emit("workflowRunsChanged");
    } catch { /* not a trace we understand */ }
  }

  /** Kind 40300 — member-gated like messages; malformed payloads dropped. */
  private absorbArtifact(event: WireEvent): void {
    if (this.seenArtifactIds.has(event.id)) return;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId) return;
    if (!this.state.isMember(communityId, channelId, event.pubkey)) return;
    let body: { type?: string; title?: string; url?: string; content?: string };
    try {
      body = JSON.parse(event.content);
    } catch {
      return;
    }
    if (!body.type || typeof body.type !== "string") return;
    this.seenArtifactIds.add(event.id);
    const artifact: Artifact = {
      id: event.id,
      authorPk: event.pubkey,
      authorName: this.displayName(event.pubkey),
      type: body.type.slice(0, 32),
      title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
      content: typeof body.content === "string" ? body.content : undefined,
      ts: event.created_at,
    };
    const list = this.artifactsByChannel.get(channelId) ?? [];
    list.push(artifact);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > 100) list.splice(0, list.length - 100);
    this.artifactsByChannel.set(channelId, list);
    this.emit("artifact", channelId, artifact);
  }

  private handleObserverFrame(event: WireEvent): void {
    const agent = event.tags.find((t) => t[0] === "agent")?.[1];
    if (!agent) return;
    let frame: ObserverEntry;
    try {
      frame = JSON.parse(this.wire.decrypt(event.pubkey, event.content));
    } catch {
      return; // not for us — ignorable by design
    }
    const feed = this.observerFeedsMap.get(agent) ?? [];
    feed.push(frame);
    if (feed.length > 30) feed.splice(0, feed.length - 30);
    this.observerFeedsMap.set(agent, feed);

    if (frame.type === "turn" && frame.status !== "started") this.workingAgentsMap.delete(agent);
    else if (frame.type === "tool" && frame.title) this.workingAgentsMap.set(agent, { activity: frame.title, ts: Date.now() });
    else if (frame.type === "turn") this.workingAgentsMap.set(agent, { activity: "working…", ts: Date.now() });

    // Jobs enrichment — owner-only detail the public wire can't provide.
    const agentPk = this.pkByName(agent);
    if (agentPk) {
      let job: Job | undefined;
      for (const j of this.jobsMap.values()) {
        if (j.agentPk === agentPk && (j.status === "seen" || j.status === "working")) job = j;
      }
      if (job) {
        if (frame.type === "tool" && frame.title) {
          job.currentTool = frame.title;
          this.emit("jobsChanged");
        } else if (frame.type === "turn" && frame.status === "failed") {
          job.status = "failed";
          job.endedAt = Date.now();
          job.currentTool = undefined;
          this.emit("jobsChanged");
        } else if (frame.type === "turn" && frame.status === "steered") {
          job.status = "steered";
          job.currentTool = undefined;
          this.emit("jobsChanged");
        }
      }
    }
    this.emit("observerFrame", agent, frame);
  }

  private handleGiftWrap(event: WireEvent): void {
    const dm = this.wire.unwrapDm(event);
    if (!dm || this.seenDmIds.has(dm.id)) return;
    this.seenDmIds.add(dm.id);
    // Conversation = the participant SET, so every member of a group DM
    // derives the same thread. 1:1 keys stay the bare peer pubkey.
    const participants = dm.participants ?? [dm.senderPk, dm.peerPk];
    const key = dmConvoKey(participants, this.pubkey) || dm.peerPk;
    const convo = this.dmConvo(key);
    convo.participants = participants;
    convo.msgs.push({ id: dm.id, senderPk: dm.senderPk, text: dm.text, ts: dm.ts });
    convo.msgs.sort((a, b) => a.ts - b.ts);
    if (convo.msgs.length > 100) convo.msgs.splice(0, convo.msgs.length - 100);
    const live = dm.ts >= this.sessionStartS;
    if (live && dm.senderPk !== this.pubkey) convo.unread++;
    this.emit("dmMessage", { id: dm.id, senderPk: dm.senderPk, text: dm.text, ts: dm.ts, peerPk: key }, { live });
  }

  private absorbDocEvent(event: WireEvent): string | undefined {
    if (this.seenDocIds.has(event.id)) return undefined;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId) return undefined;
    // A d tag makes it a named wiki page, not the channel's doc — pages
    // are gated community-wide, channel docs by their channel.
    const slug = event.tags.find((t) => t[0] === "d")?.[1];
    const allowed = slug
      ? this.state.isCommunityMember(communityId, event.pubkey)
      : this.state.isMember(communityId, channelId, event.pubkey);
    if (!allowed) return undefined;
    this.seenDocIds.add(event.id);
    if (slug) {
      const key = `${communityId}:${slug}`;
      let page = this.wikiMap.get(key);
      if (!page) {
        this.wikiMap.set(key, (page = { slug, title: slug, channelId, communityId, count: 0, latestId: "", latestTs: 0, latestAuthor: "", latestContent: "" }));
      }
      page.count++;
      if (event.created_at > page.latestTs || (event.created_at === page.latestTs && event.id < page.latestId)) {
        page.latestTs = event.created_at;
        page.latestId = event.id;
        page.latestAuthor = event.pubkey;
        page.latestContent = event.content;
        page.channelId = channelId;
        // Title precedence: the explicit tag, else the page's own first
        // heading, else the slug. Agents writing via fez_wiki_write don't
        // always set the tag, and "open-questions" is a worse label than
        // the "# Open Questions" sitting in the content.
        // Title precedence: an INFORMATIVE tag, else the page's own first
        // heading, else the slug. A tag that merely repeats the slug
        // ("open-questions") carries nothing — agents pass the slug as
        // the page name when that's how they were asked for it — so the
        // heading in the content wins over it.
        const tagged = event.tags.find((t) => t[0] === "title")?.[1]?.trim();
        const heading = /^#{1,6}\s+(.+)$/m.exec(event.content)?.[1]?.trim();
        page.title = (tagged && tagged !== slug ? tagged : undefined) ?? heading ?? tagged ?? slug;
      }
      return channelId;
    }
    let info = this.docsByChannelMap.get(channelId);
    if (!info) this.docsByChannelMap.set(channelId, (info = { count: 0, latestId: "", latestTs: 0, latestAuthor: "", latestContent: "" }));
    info.count++;
    if (event.created_at > info.latestTs || (event.created_at === info.latestTs && event.id < info.latestId)) {
      info.latestTs = event.created_at;
      info.latestId = event.id;
      info.latestAuthor = event.pubkey;
      info.latestContent = event.content;
    }
    return channelId;
  }

  private handleDocEvent(event: WireEvent): void {
    const channelId = this.absorbDocEvent(event);
    if (channelId) this.emit("docChanged", channelId);
  }
}
