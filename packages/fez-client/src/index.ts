import { wikiSlug, orderVersions, assertDocBase, docCommentThreads, type DocAnchor } from "./docs.js";
export * from "./docs.js";
export * from "./memory.js";
export * from "./artifacts.js";
export { parseQuery, describeQuery, type Query, type QuerySource, type QueryView } from "./query-lang.js";
export {
  latestPerAddress,
  shouldArm,
  nextCreatedAt,
  relativeWhen,
  STALE_AFTER_S,
  type ReminderRecord,
  type ReminderBody,
  type ReminderStatus,
} from "./reminders.js";
import type { Query } from "./query-lang.js";
import { inputForm, inputOrigin, validateInputResponse, INPUT_WAIT_MS, type PendingInput, type InputResponse, type InputHistoryEntry } from "./agent-input.js";
export * from "./agent-input.js";
import { nextCreatedAt, STALE_AFTER_S, type ReminderBody, type ReminderRecord } from "./reminders.js";

/** One row of a `runQuery` result — a task, approval, page, mention or run,
 * normalized so any surface (doc-block, live tool, exported extension)
 * renders the same shape. */
export interface QueryRow {
  id: string;
  title: string;
  group: string;
  done?: boolean;
  who?: string;
  ts: number;
  meta?: string;
}
import { WorkspaceState, cleanSource, setStatePersistence, type Channel, type Role, type StatePersistence } from "./workspace-state.js";
export * from "./workspace-state.js";

/**
 * @fezchat/client — the headless fez protocol brain: subscriptions, trust
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
  /** NIP-01 filter by event id — how you fetch specific events back. */
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  /** NIP-50 full-text query (fez-relay: case-insensitive AND over tokens). */
  search?: string;
  [key: `#${string}`]: string[] | undefined;
}

export interface WireQueryResult {
  events: WireEvent[];
  failures: { url: string; reason: string }[];
}

export interface HistoryLoadState {
  status: "idle" | "loading" | "ready" | "error";
  operation: "recent" | "older";
  partial?: boolean;
  error?: string;
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
/** One flagged message in the moderation queue, with everyone who flagged it. */
export interface ReportEntry {
  targetId: string;
  channelId?: string;
  authorPk?: string;
  reporters: { pk: string; reason: string; at: number }[];
  resolved?: { action: "removed" | "banned" | "dismissed"; by?: string };
}

export interface Wire {
  pubkey: string;
  publish(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent>;
  /**
   * Sign WITHOUT publishing — sealed schedule intents embed a future-
   * dated, pre-signed event. Optional: a wire that can't provide it
   * degrades scheduleMessage to the legacy plaintext form (sentinel-
   * fired). The TUI's wire and BrowserWire both provide it.
   */
  signEvent?(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): WireEvent | Promise<WireEvent>;
  subscribe(filters: WireFilter[], onEvent: (event: WireEvent) => void): () => void;
  query(filters: WireFilter[]): Promise<WireEvent[]>;
  /** Complete EOSE versus partial/failing reads; older wires can still reject query(). */
  queryWithStatus?(filters: WireFilter[]): Promise<WireQueryResult>;
  /**
   * Crypto may be SYNC OR ASYNC: a wire that holds the key in-process
   * returns plain values; a wire whose key lives behind a custody seam
   * (the desktop signs in Rust — the webview never sees the secret)
   * returns promises. Callers always `await`, which is a no-op on plain
   * values, so sync backends pay nothing.
   */
  encrypt(peerPubkey: string, plaintext: string): string | Promise<string>;
  decrypt(peerPubkey: string, ciphertext: string): string | Promise<string>;
  sendDm(recipientPubkey: string, text: string): Promise<string>;
  /** Group DM (one rumor, one wrap per recipient + self-copy). Optional — older backends are 1:1 only. */
  sendGroupDm?(recipientPubkeys: string[], text: string): Promise<string>;
  unwrapDm(event: WireEvent): DmRumor | undefined | Promise<DmRumor | undefined>;
  /**
   * Which relays this wire talks to. The FIRST is the workspace — a
   * relay IS the workspace, so a client with nothing stored learns
   * where it is from here rather than coming up placeless.
   */
  relays?: string[];
  /**
   * The relay's NIP-11 information document — the workspace's identity
   * card, and the only place its owner is declared. Optional so a
   * minimal backend can omit it; without it the workspace stays
   * unclaimed and nothing governed is trusted.
   */
  relayInfo?(relay: string): Promise<RelayInfoDoc | undefined>;
  /**
   * Mint a NIP-98 Authorization header for one HTTP request — the key
   * stays behind the seam, same custody pattern as signEvent. This is
   * how a GUI surface reads the relay's gated HTTP endpoints (push
   * journal, review diff) and knocks on gated writes (merge).
   */
  httpAuth?(url: string, method: string): string | Promise<string>;
}

/**
 * The NIP-11 document, whole.
 *
 * The extra fields are the point. A relay extension advertises where it
 * put something (`fez_git.clone_base`) precisely so clients can find it
 * without reconstructing a URL from the websocket address — which is
 * right on a laptop and silently wrong behind any proxy. Narrowing this
 * to the four identity fields threw those away at the type level while
 * the bytes were sitting right there.
 */
export type RelayInfoDoc = {
  name?: string;
  description?: string;
  pubkey?: string;
  icon?: string;
} & Record<string, unknown>;

// ── Mentions (mirror of src/mentions.ts) ─────────────────────────────────
// Duplicated by design, same as the kinds below: this package stays
// dependency-light and browser-safe. An equivalence gate in fez-evals
// proves the two agree, so the surface that PAINTS a mention and the
// surface that TAGS it can never disagree about what a mention is —
// which is exactly how a highlight came to promise a reach it didn't
// have.

/** @see src/mentions.ts — the @ must open a word, so emails don't mention. */
const MENTION = /(?:^|[^\w@/])@([\w-]+)/g;

/** Every name a message @-mentions, lowercased, in first-seen order. */
export function mentionedNames(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(MENTION)) {
    const name = match[1].toLowerCase();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface MentionPart {
  /** The literal text of this run, mention or not. */
  text: string;
  /** Present when this run IS a mention: the name, as written. */
  name?: string;
}

/**
 * The same content, cut into runs so a renderer can style the mentions
 * without owning a second opinion about where they are. Every part
 * concatenated back is the input, exactly.
 */
export function splitMentions(content: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let cut = 0;
  for (const match of content.matchAll(MENTION)) {
    // The pattern eats the character BEFORE the @ (that is what proves
    // the @ opens a word), so find the @ inside the match rather than
    // slicing from its start and swallowing that character.
    const start = (match.index ?? 0) + match[0].indexOf("@");
    const end = start + 1 + match[1].length;
    if (start > cut) parts.push({ text: content.slice(cut, start) });
    parts.push({ text: content.slice(start, end), name: match[1] });
    cut = end;
  }
  if (cut < content.length) parts.push({ text: content.slice(cut) });
  return parts;
}

// ── Kinds (fez registry — see src/kinds.ts for the full docs) ────────────
// Duplicated by design (this package stays dependency-light), exported so
// the registry-agreement gate in fez-evals can prove it never drifts from
// src/kinds.ts.

export const K = {
  AGENT_METADATA: 47000,
  /** Owner-signed "this is my agent" — summon authority for siblings. */
  AGENT_ATTESTATION: 47006,
  INPUT_REQUEST: 47013,
  INPUT_RESPONSE: 47014,
  CHIT: 47007,
  SALT: 47008,
  /** Retired with the flat model — the number stays burned. */
  COMMUNITY_RETIRED: 47100,
  CHANNEL: 47101,
  MEMBERSHIP: 47102,
  MESSAGE: 47103,
  /** The one roster's d tag — a relay is a workspace, so nothing else names it. */
  ROSTER_D: "roster",
  BANS_D: "bans",
  /** The 30047 d tag for withheld event-ids — reversible moderator removal. */
  REMOVED_D: "removed",
  /** The 30047 d tag for dismissed report targets — the queue's "handled, no action". */
  DISMISSED_D: "dismissed",
  /** NIP-56 report — reason encrypted to each moderator, one event per recipient. */
  REPORT: 1984,
  TYPING: 20002,
  PRESENCE: 20001,
  DRAFT: 20003,
  OBSERVER: 20004,
  THREAD_SUMMARY: 39005,
  WORKFLOW_RUN: 47200,
  MEMORY: 47210,
  MEMORY_UPDATE: 47211,
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
  REMINDER_V2: 30176,
  READ_STATE: 30078,
  /** The personal mute list's d tag on 30078 — self-encrypted, never public p-tags. */
  MUTES_D: "mutes",
  /** NIP-78 application data. Same kind as READ_STATE; the `d` tag separates them. */
  APP_DATA: 30078,
  PROFILE: 0,
  USER_STATUS: 30315,
  BAN_LIST: 30047,
  ARTIFACT: 40300,
  /** A payment, e-tagged to the message it paid for (spec §4). matches src/protocol/kinds.ts */
  PAYMENT_RECEIPT: 47040,
} as const;

const DM_FUZZ_WINDOW_S = 2 * 86_400;
const PRESENCE_TTL_MS = 90_000;
const PRESENCE_BEAT_MS = 30_000;
const TYPING_TTL_MS = 8000;
const MSG_CACHE_CAP = 1000;
const HISTORY_LIMIT = 50;
const PAGE_SIZE = 50;
const JOB_CAP = 100;
/** setTimeout's hard cap (~24.9 days) — a delay beyond this re-arms in
 * chunks rather than firing early (same shape as the relay scheduler's
 * fire(), packages/fez-relay/src/scheduler.ts). */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// ── Public state shapes ──────────────────────────────────────────────────

/** One attachment described by a NIP-92 imeta tag. */
export interface MediaAttachment {
  url: string;
  /** Declared MIME. The only thing that can classify a content-addressed
   *  blob, whose URL is a bare hash with no extension to sniff. */
  mime?: string;
  /** "WxH" when the sender measured it — lets a renderer reserve the box
   *  before the bytes land, so arriving media doesn't shove the timeline. */
  dim?: string;
  size?: number;
}

/**
 * Project an event's imeta tags into attachments, in tag order.
 *
 * Each tag is ["imeta", "url …", "m …", …] — space-separated key/value
 * pairs, one per element. Unknown keys (NIP-92 also defines alt, blurhash,
 * fallback, service) are dropped rather than fought over; an entry with no
 * url describes nothing and is skipped. Malformed fields never discard the
 * entry, because a half-described attachment still renders.
 */
export function parseImeta(tags: string[][]): MediaAttachment[] {
  const out: MediaAttachment[] = [];
  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    const fields = new Map<string, string>();
    for (const part of tag.slice(1)) {
      const space = part.indexOf(" ");
      if (space > 0) fields.set(part.slice(0, space), part.slice(space + 1));
    }
    const url = fields.get("url");
    if (!url) continue;
    const size = Number(fields.get("size"));
    out.push({
      url,
      ...(fields.get("m") ? { mime: fields.get("m") } : {}),
      ...(fields.get("dim") ? { dim: fields.get("dim") } : {}),
      ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    });
  }
  return out;
}

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
  /** Who this message actually tagged. Rendering an @name that reached
   *  nobody as though it had is the same silence, one layer later. */
  mentionPks: string[];
  /** Honest tombstone (Buzz's decision: a visible removal, not a silent hole). */
  deletedBy?: "author" | "moderator";
  /** NIP-92 attachments declared on the event. Present so a renderer can
   *  trust the sender's MIME instead of guessing from the URL. */
  media?: MediaAttachment[];
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
  /** The channel the artifact was published into — write-back targets THIS,
   * never whatever channel the app happens to have in scope. */
  channelId: string;
  authorPk: string;
  authorName: string;
  type: string;
  title?: string;
  url?: string;
  content?: string;
  ts: number;
  /** The thread root this artifact belongs to (root `e` tag), when it was
   * produced inside a thread — lets a client scope it to that thread. */
  rootId?: string;
}

export interface DmMessage {
  id: string;
  senderPk: string;
  text: string;
  ts: number;
  edited?: boolean;
  editTs?: number;
  /** DMs have no moderator — only the author can unsend. */
  deletedBy?: "author";
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
  /** Where it was written from; the page belongs to the workspace. */
  channelId: string;
}

export interface DocCommentReply {
  id: string;
  authorPk: string;
  text: string;
  ts: number;
  /** Who this comment actually tagged. A name it did NOT reach must not
   *  render as though it had. */
  mentionPks: string[];
}

/** A comment thread anchored to a line of a doc (Notion's margin note). */
export interface DocCommentThread extends DocCommentReply {
  anchor: string;
  anchorContext?: DocAnchor;
  writerPk?: string;
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
export * from "./skill-source.js";
export * from "./skill-attach.js";
export * from "./persona-keys.js";
export * from "./salt.js";
import { chitEvidence, deriveSalt, type SaltPanel } from "./salt.js";
import {
  resolveMentions,
  type MentionBindings,
  type MentionCandidate,
  type MentionResolution,
} from "./mentions.js";

export function taskKey(itemText: string): string {
  return itemText.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

export interface TaskState {
  done: boolean;
  byPk: string;
  ts: number;
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
  historyChanged: (channelId: string) => void;
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
  docCommentsChanged: (channelId: string) => void;
  jobsChanged: () => void;
  observerFrame: (agent: string, frame: ObserverEntry) => void;
  inputsChanged: () => void;
  workflowRunsChanged: () => void;
  /** A typed artifact landed in a channel. */
  artifact: (channelId: string, artifact: Artifact) => void;
  /** A payment receipt landed, e-tagging `targetId` — live only (backfill
   * is read via paymentReceiptsFor() at mount, the same as reactions). */
  paymentReceipt: (channelId: string, targetId: string) => void;
  /** Client-level announcements a view should surface (first-run bootstrap etc.). */
  notice: (text: string) => void;
  /** One of OWN reminders reached its time while this client was alive. */
  reminderDue: (note: string) => void;
  /**
   * An own reminder was written — created, snoozed, completed or
   * cancelled, here or on another device. A pane listing them can
   * re-read instead of showing whatever was true when it mounted.
   */
  remindersChanged: () => void;
}

export { setStatePersistence, type StatePersistence };

export class FezClient {
  readonly state = new WorkspaceState();
  readonly pubkey: string;

  private wire: Wire;
  private relayInfoDoc?: RelayInfoDoc;
  private listeners = new Map<keyof ClientEvents, Set<(...args: never[]) => void>>();
  private unsubscribeLive?: () => void;
  private subscribedChannelIds = "";
  private sessionStartS = Math.floor(Date.now() / 1000);
  private pendingChannels = new Map<string, Promise<string>>();

  // messages + threads
  private names = new Map<string, string>();
  private profiles = new Map<string, string>(); // kind-0 name/display_name — humans stop being hex
  private statuses = new Map<string, string>(); // kind-30315 status text
  private seenMessages = new Set<string>();
  private messagesByChannel = new Map<string, Msg[]>();
  /** Pubkeys I've personally muted — client-side, self-encrypted, tells no one. */
  private mutedByMe = new Set<string>();
  private msgByIdMap = new Map<string, Msg>();
  private threadNoByRoot = new Map<string, number>();
  private rootByThreadNoMap = new Map<number, string>();
  private nextThreadNo = 1;
  private summaryByRoot = new Map<string, { replyCount: number; lastAuthorTs: number; summaryTs: number }>();
  private exhaustedChannels = new Set<string>();
  private historyByChannel = new Map<string, HistoryLoadState>();
  private olderUntil = new Map<string, number>();

  // reactions
  private reactionsByTarget = new Map<string, Map<string, Set<string>>>();
  private reactionIndex = new Map<string, { targetId: string; emoji: string; authorPk: string; ts: number }>();

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
  private inputRequests = new Map<string, PendingInput>();
  private closedInputs = new Map<string, { expiresAt: number; closedAt?: number; responseId?: string }>();
  private inputTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inputRecords = new Map<string, PendingInput & { requestedAt: number; closedAt?: number; responseId?: string }>();
  private inputAnswers = new Map<string, { requestKey: string; response: unknown; at: number }>();
  private workingAgentsMap = new Map<string, { activity: string; ts: number; root?: string }>();
  private workflowRunsMap = new Map<string, WorkflowRunInfo>();

  // DMs
  private dmConvos = new Map<string, { msgs: DmMessage[]; unread: number; participants?: string[] }>();
  private seenDmIds = new Set<string>();
  /** Serial chain for handlers that decrypt — an async custody seam
   * (desktop signs in Rust) must not reorder a feed. */
  private cryptoIngest: Promise<void> = Promise.resolve();

  // docs
  private docsByChannelMap = new Map<string, DocInfo>();
  private wikiMap = new Map<string, WikiDoc>();
  private artifactsByChannel = new Map<string, Artifact[]>();
  private seenArtifactIds = new Set<string>();
  private docEvents = new Map<string, WireEvent>();
  private docCommentEvents = new Map<string, WireEvent>();

  // payment receipts (47040), keyed by the message they e-tag
  private receiptsByTarget = new Map<string, WireEvent[]>();
  private seenReceiptIds = new Set<string>();

  /** Armed reminder timers (id → timer); the client fires its OWN
   * reminders while alive — the desktop toasts them, the sentinel keeps
   * covering app-closed delivery (hosts dedupe via runner_status). */
  private reminderTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  /**
   * Run a parsed query against the relay — the one runner behind every
   * surface that answers a `parseQuery` sentence: the ```fez:query``` doc
   * block, loom's live-tool read bridge, and exported tool extensions.
   * Read-only; nothing is created. Each source is a couple of filters.
   */
  async runQuery(query: Query): Promise<QueryRow[]> {
    const since = query.sinceDays ? Math.floor(Date.now() / 1000) - query.sinceDays * 86400 : undefined;
    const applyLimits = (rows: QueryRow[]): QueryRow[] => rows.sort((a, b) => b.ts - a.ts).slice(0, query.limit);

    if (query.source === "tasks") {
      const pages = [...this.wikiDocs().values()];
      const channelDocs = [...this.docsByChannel().entries()].map(([channelId, info]) => ({
        channelId,
        info,
        ref: this.channelRef(channelId),
      }));
      const states = new Map<string, { done: boolean; byPk: string }>();
      for (const page of pages) {
        for (const [key, state] of await this.docTasks({ slug: page.slug })) states.set(key, state);
      }
      for (const doc of channelDocs) {
        for (const [key, state] of await this.docTasks({ channelId: doc.channelId })) states.set(key, state);
      }
      const rows: QueryRow[] = [];
      const collect = (content: string, where: string, ts: number) => {
        for (const line of content.split("\n")) {
          const match = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
          if (!match) continue;
          const text = match[2].trim();
          const state = states.get(taskKey(text));
          const done = state?.done ?? match[1].toLowerCase() === "x";
          if (query.open === true && done) continue;
          if (query.open === false && !done) continue;
          rows.push({ id: `${where}:${text}`, title: text, group: where, done, who: state ? this.displayName(state.byPk) : undefined, ts });
        }
      };
      for (const page of pages) collect(page.latestContent, page.title, page.latestTs * 1000);
      for (const doc of channelDocs) collect(doc.info.latestContent, `#${doc.ref!.name}`, doc.info.latestTs * 1000);
      return applyLimits(rows);
    }

    if (query.source === "approvals" || query.source === "mentions") {
      const channelIds = [...this.state.workspace.channels.values()].map((c) => c.id);
      const events = await this.wire.query([{ kinds: [47103], "#h": channelIds, limit: 500, ...(since ? { since } : {}) }]);
      const wanted =
        query.source === "approvals"
          ? events.filter((e) => e.content.startsWith("⛔ approval needed:") || e.content.startsWith("❓ choose:"))
          : events.filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === this.pubkey));
      const answered = new Set<string>();
      if (wanted.length > 0 && query.source === "approvals") {
        for (const reaction of await this.wire.query([{ kinds: [7], "#e": wanted.map((e) => e.id) }])) {
          const target = reaction.tags.find((t) => t[0] === "e")?.[1];
          if (target) answered.add(target);
        }
      }
      const rows = wanted
        .filter((e) => (query.open === true ? !answered.has(e.id) : query.open === false ? answered.has(e.id) : true))
        .filter((e) => !query.who || this.displayName(e.pubkey).toLowerCase() === query.who)
        .map((event) => ({
          id: event.id,
          title: event.content.split("\n")[0].replace(/^(⛔ approval needed:|❓ choose:)\s*/, ""),
          group: this.channelRef(event.tags.find((t) => t[0] === "h")?.[1] ?? "")?.name ?? "",
          who: this.displayName(event.pubkey),
          ts: event.created_at * 1000,
          meta: answered.has(event.id) ? "answered" : "waiting",
        }));
      return applyLimits(rows);
    }

    if (query.source === "pages") {
      const rows = [...this.wikiDocs().values()]
        .filter((page) => !since || page.latestTs >= since)
        .map((page) => ({
          id: page.slug,
          title: page.title,
          group: this.displayName(page.latestAuthor),
          who: this.displayName(page.latestAuthor),
          ts: page.latestTs * 1000,
          meta: `${page.count} version${page.count === 1 ? "" : "s"}`,
        }));
      return applyLimits(rows);
    }

    if (query.source === "runs") {
      const rows = [...this.workflowRuns().entries()]
        .filter(([, run]) => !since || run.ts / 1000 >= since)
        .map(([id, run]) => ({ id, title: run.workflow, group: run.status, ts: run.ts, meta: run.status.replace(/_/g, " ") }));
      return applyLimits(rows);
    }

    throw new Error(`"${query.source}" isn't wired up yet — tasks, approvals, pages, mentions and runs are`);
  }
  private agentMeta = new Map<string, { about?: string; skills?: string[]; repo?: string; branch?: string; aliases?: string[] }>();
  /** What an agent announced about itself (47000 about/skills/repo/branch/aliases) — undefined for humans. */
  agentInfo(pk: string): { about?: string; skills?: string[]; repo?: string; branch?: string; aliases?: string[] } | undefined {
    return this.agentMeta.get(pk);
  }

  /** Every pubkey we can name (agents outrank profiles) — autocomplete fodder. */
  knownNames(): Map<string, string> {
    const merged = new Map<string, string>(this.profiles);
    for (const [pk, name] of this.names) merged.set(pk, name);
    return merged;
  }

  /**
   * Everyone in this workspace, with the name they publish for
   * themselves — the candidate set for resolving @mentions.
   *
   * Membership is owner-signed and workspace-wide, so this is the one
   * authority over "who is in this room", and the room is the whole
   * workspace. Names remain self-asserted and non-unique;
   * resolveMentions() handles the collisions rather than hiding them.
   *
   * The channelId is still taken so callers read naturally and so a
   * future per-channel visibility rule has a seam to land on.
   */
  mentionCandidates(_channelId?: string): MentionCandidate[] {
    const out: MentionCandidate[] = [];
    const seen = new Set<string>();
    const roster = new Set(this.state.workspace.members.keys());
    if (this.state.workspace.owner) roster.add(this.state.workspace.owner);
    for (const pubkey of roster) {
      const name = this.names.get(pubkey) ?? this.profiles.get(pubkey);
      if (!name || seen.has(pubkey)) continue;
      seen.add(pubkey);
      out.push({ pubkey, name, isMember: true, aliases: this.agentMeta.get(pubkey)?.aliases });
    }
    return out;
  }

  /**
   * Resolve the @mentions in a message against a channel's roster.
   * Returns the pubkeys to tag plus what went wrong, so a caller can
   * tell the sender rather than dropping a mention in silence.
   *
   * `bindings` carries the choices a human made in an autocomplete, so
   * those names never need a lookup at send time.
   */
  resolveMentionsIn(text: string, channelId: string, bindings?: MentionBindings): MentionResolution {
    return resolveMentions(text, this.mentionCandidates(channelId), bindings);
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
    const list = this.messagesByChannel.get(channelId) ?? [];
    // The personal plane: someone you muted vanishes from YOUR reads only.
    // ponytail: unread counts still include muted authors — filter them in
    // the unread walk too if that ever grates.
    if (this.mutedByMe.size === 0) return list;
    return list.filter((m) => !this.mutedByMe.has(m.authorPk));
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
    return (this.messagesByChannel.get(channelId) ?? []).filter(
      (m) => m.rootId === rootId && !this.mutedByMe.has(m.authorPk)
    );
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
  pendingInputs(): PendingInput[] {
    return [...this.inputRequests.values()].filter(r => r.expiresAt > Date.now() && this.state.isMember(r.agentPk));
  }
  /** A sent answer is awaiting delivery, not waiting on the human. */
  waitingInputs(): PendingInput[] {
    const answered = new Set<string>();
    for (const answer of this.inputAnswers.values()) {
      const request = this.inputRequests.get(answer.requestKey);
      if (!request) continue;
      try { validateInputResponse(request.form, answer.response); answered.add(request.id); } catch { /* invalid signed reply */ }
    }
    return this.pendingInputs().filter(request => !answered.has(request.id));
  }
  /** Recent private requests; only a receipt naming our signed answer confirms delivery. */
  inputHistory(): InputHistoryEntry[] {
    return [...this.inputRecords.values()].filter(record => record.requestedAt >= Date.now() - 30 * 86400_000).sort((a, b) => b.requestedAt - a.requestedAt).slice(0, 100).map(record => {
      const candidates = [...this.inputAnswers].filter(([, answer]) => answer.requestKey === record.id)
        .sort((a, b) => b[1].at - a[1].at || b[0].localeCompare(a[0]));
      const accepted = candidates.find(([id]) => id === record.responseId);
      let response: InputResponse | undefined;
      let answeredAt: number | undefined;
      for (const [, answer] of accepted ? [accepted] : candidates) {
        try { response = validateInputResponse(record.form, answer.response); answeredAt = answer.at; break; } catch { /* invalid signed reply */ }
      }
      const status = record.closedAt !== undefined ? accepted && response ? "received"
        : record.closedAt >= record.expiresAt ? "expired" : "closed"
        : record.expiresAt <= Date.now() ? "expired" : response ? "sent" : "pending";
      return { ...record, status, response, answeredAt };
    });
  }
  /** Query on demand; answers remain encrypted at rest on the relay. */
  async loadInputHistory(): Promise<void> {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const events = await this.wire.query([
      { kinds: [K.INPUT_REQUEST], "#p": [this.pubkey], since, limit: 300 },
      { kinds: [K.INPUT_RESPONSE], authors: [this.pubkey], since, limit: 500 },
    ]);
    for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
      if (event.kind === K.INPUT_RESPONSE) await this.handleInputResponse(event).catch(() => {});
      else await this.handleInputRequest(event).catch(() => {});
    }
    const missing = [...this.inputRecords.values()].flatMap(record => record.responseId && !this.inputAnswers.has(record.responseId) ? [record.responseId] : []);
    if (missing.length) {
      for (const event of await this.wire.query([{ kinds: [K.INPUT_RESPONSE], authors: [this.pubkey], ids: missing, limit: missing.length }])) {
        await this.handleInputResponse(event).catch(() => {});
      }
    }
    this.emit("inputsChanged");
  }
  private async handleInputResponse(event: WireEvent): Promise<void> {
    if (event.kind !== K.INPUT_RESPONSE || event.pubkey !== this.pubkey || this.inputAnswers.has(event.id)) return;
    const peer = event.tags.find(t => t[0] === "p")?.[1];
    const requestId = event.tags.find(t => t[0] === "d")?.[1];
    if (!peer || !this.state.isMember(peer) || !requestId || requestId.length > 200) return;
    const raw = await this.wire.decrypt(peer, event.content);
    if (new TextEncoder().encode(raw).length > 24_000) return;
    this.inputAnswers.set(event.id, { requestKey: `${peer}:${requestId}`, response: JSON.parse(raw), at: event.created_at * 1000 });
    if (this.inputAnswers.size > 500) this.inputAnswers.delete(this.inputAnswers.keys().next().value!);
    this.emit("inputsChanged");
  }
  async answerInput(id: string, answer: InputResponse): Promise<void> {
    const request = this.pendingInputs().find(r => r.id === id);
    if (!request) throw new Error("This question has expired or was already answered");
    const response = validateInputResponse(request.form, answer);
    const event = await this.wire.publish({ kind: K.INPUT_RESPONSE, tags: [["p", request.agentPk], ["d", request.requestId]],
      content: await this.wire.encrypt(request.agentPk, JSON.stringify(response)) });
    await this.handleInputResponse(event);
    // The agent's closed event is the acknowledgement. Keep the card until
    // it arrives, so a relay accepting but not forwarding an answer is visible.
  }
  private async handleInputRequest(event: WireEvent): Promise<void> {
    if (event.kind !== K.INPUT_REQUEST || !this.state.isMember(event.pubkey) || !event.tags.some(t => t[0] === "p" && t[1] === this.pubkey)) return;
    const requestId = event.tags.find(t => t[0] === "d")?.[1];
    if (!requestId || requestId.length > 200) return;
    const raw = JSON.parse(await this.wire.decrypt(event.pubkey, event.content));
    if (!raw || (raw.status !== "pending" && raw.status !== "closed") || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= 0 || raw.expiresAt > Date.now() + INPUT_WAIT_MS + 60_000) return;
    const id = `${event.pubkey}:${requestId}`;
    const previous = this.inputRecords.get(id);
    const form = previous?.form ?? (raw.form ? inputForm(raw.form) : undefined);
    const origin = previous ? previous.origin : inputOrigin(raw.origin, event.pubkey, this.pubkey);
    const earliest = raw.expiresAt - INPUT_WAIT_MS;
    const requestedAt = typeof raw.requestedAt === "number" && Number.isFinite(raw.requestedAt) && raw.requestedAt >= earliest && raw.requestedAt <= raw.expiresAt
      ? raw.requestedAt : previous?.requestedAt ?? Math.min(raw.expiresAt, Math.max(earliest, event.created_at * 1000));
    const closedAt = typeof raw.closedAt === "number" && Number.isFinite(raw.closedAt) && raw.closedAt >= requestedAt && raw.closedAt <= event.created_at * 1000 + 1000
      ? raw.closedAt : event.created_at * 1000;
    const closure = this.closedInputs.get(id)?.closedAt !== undefined ? this.closedInputs.get(id)
      : raw.status === "closed" ? { expiresAt: raw.expiresAt, closedAt,
        responseId: typeof raw.responseId === "string" && /^[a-f0-9]{64}$/.test(raw.responseId) ? raw.responseId : undefined } : undefined;
    if (form && previous?.closedAt === undefined) {
      this.inputRecords.set(id, { ...previous, id, requestId, agentPk: event.pubkey, expiresAt: raw.expiresAt, form, origin, requestedAt, ...closure });
      if (this.inputRecords.size > 200) {
        const oldest = [...this.inputRecords.values()].filter(record => !this.inputRequests.has(record.id)).sort((a, b) => a.requestedAt - b.requestedAt)[0];
        if (oldest) this.inputRecords.delete(oldest.id);
      }
    }
    for (const [key, closed] of this.closedInputs) if (closed.expiresAt <= Date.now() - 30 * 86400_000) this.closedInputs.delete(key);
    const close = () => {
      this.inputRequests.delete(id);
      if (closure || raw.expiresAt > Date.now()) this.closedInputs.set(id, closure ?? { expiresAt: raw.expiresAt });
      if (this.closedInputs.size > 500) {
        const oldest = [...this.closedInputs].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
        this.closedInputs.delete(oldest[0]);
      }
      clearTimeout(this.inputTimers.get(id));
      this.inputTimers.delete(id);
      this.emit("inputsChanged");
    };
    if (raw.status === "closed" || raw.expiresAt <= Date.now()) { close(); return; }
    if (raw.status !== "pending" || this.closedInputs.has(id) || this.inputRequests.has(id) || this.inputRequests.size >= 64) return;
    if (!form) return;
    this.inputRequests.set(id, { id, requestId, agentPk: event.pubkey, expiresAt: raw.expiresAt, form, origin });
    this.inputTimers.set(id, setTimeout(close, raw.expiresAt - Date.now()));
    this.emit("inputsChanged");
  }
  workingAgents(): ReadonlyMap<string, { activity: string; ts: number; root?: string }> {
    const now = Date.now();
    for (const [name, w] of this.workingAgentsMap) if (now - w.ts > 180_000) this.workingAgentsMap.delete(name);
    const working = new Map(this.workingAgentsMap);
    for (const request of this.waitingInputs()) working.set(this.displayName(request.agentPk), {
      activity: "Waiting for your answer", ts: now, root: request.origin?.kind === "channel" ? request.origin.rootId : undefined,
    });
    return working;
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
  /** Payment receipts (47040) e-tagging one message — the raw signed
   * events, verbatim, same as fetchEvent(): a receipt is only worth
   * anything if its signature still verifies, so nothing here should
   * ever reconstruct one. */
  paymentReceiptsFor(targetId: string): readonly WireEvent[] {
    return this.receiptsByTarget.get(targetId) ?? [];
  }
  channelExhausted(channelId: string): boolean {
    return this.exhaustedChannels.has(channelId);
  }
  /** Name a channel and the workspace it sits in — breadcrumbs, jump-to, notifications. */
  channelRef(
    channelId: string
  ): { name: string; workspaceName: string; source?: string; meta?: Record<string, string> } | undefined {
    const channel = this.state.workspace.channels.get(channelId);
    return channel
      ? {
          name: channel.name,
          workspaceName: this.state.workspace.name,
          // What opened it, and what it wants said about itself — a
          // header showing the branch a repo tracks needs both, and
          // neither is reachable from a name.
          source: channel.source,
          meta: channel.meta,
        }
      : undefined;
  }

  /**
   * Fetch one signed event back by id, verbatim. The share path needs
   * this: re-publication means republishing the SIGNATURE — fez.chat's
   * shared-artifacts endpoint verifies schnorr, and a reconstructed
   * event (new tag order, trimmed field) would 401 at the door.
   */
  async fetchEvent(id: string): Promise<WireEvent | undefined> {
    const events = await this.wire.query([{ ids: [id], limit: 1 }]);
    return events.find((e) => e.id === id);
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Publish into the scoped channel. Thread tags follow Buzz's NIP-10 shape when replying. */
  async sendChannelMessage(
    text: string,
    opts?: {
      threadRootId?: string;
      mentionPks?: string[];
      channelId?: string;
      /** NIP-92 media metadata, one entry per attachment (["imeta",
       * "url <u>", "m <mime>", "size <n>"]) — structured so the agent
       * runner can hand vision models the pixels instead of a URL. */
      imeta?: string[][];
    }
  ): Promise<Msg> {
    // channelId overrides the scope — for surfaces that address a
    // channel by NAME rather than by standing in it (a /repo command run
    // from anywhere posting a line root into the repo's channel).
    const current = opts?.channelId
      ? this.state.workspace.channels.get(opts.channelId)
      : this.state.currentChannel();
    if (!current) throw new Error(opts?.channelId ? "no such channel" : "no channel scope");
    const threadTags: string[][] = [];
    if (opts?.threadRootId) {
      const replies = this.threadReplies(current.id, opts.threadRootId);
      const parentId = replies.at(-1)?.id ?? opts.threadRootId;
      if (parentId !== opts.threadRootId) threadTags.push(["e", opts.threadRootId, "", "root"]);
      threadTags.push(["e", parentId, "", "reply"]);
    }
    const event = await this.wire.publish({
      kind: K.MESSAGE,
      tags: [
        ["h", current.id],
        ...threadTags,
        ...(opts?.mentionPks ?? []).map((pk) => ["p", pk]),
        ...(opts?.imeta ?? []),
      ],
      content: text,
    });
    this.seenMessages.add(event.id);
    return this.cacheMessage(current.id, event);
  }

  async editLastOwnMessage(channelId: string, text: string): Promise<Msg | undefined> {
    const target = (this.messagesByChannel.get(channelId) ?? []).filter((m) => m.authorPk === this.pubkey).at(-1);
    if (!target) return undefined;
    const event = await this.wire.publish({
      kind: K.MSG_EDIT,
      tags: [["e", target.id], ["h", channelId]],
      content: text,
    });
    this.handleMsgEdit(event);
    return this.msgByIdMap.get(target.id);
  }

  /** Edit a specific own message (author-only, enforced by every consumer's handleMsgEdit). */
  async editMessage(channelId: string, targetId: string, text: string): Promise<Msg | undefined> {
    const target = this.msgByIdMap.get(targetId);
    const dmTarget = target ? undefined : this.dmMsgById(targetId)?.msg;
    if ((!target || target.authorPk !== this.pubkey) && (!dmTarget || dmTarget.senderPk !== this.pubkey)) return undefined;
    const event = await this.wire.publish({
      kind: K.MSG_EDIT,
      tags: [["e", targetId], ["h", channelId]],
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

  /** WHEN my reaction was placed (seconds), not just whether. The wallet's
   * consent card needs the time: a decision after the consent window
   * closed approves nothing, and rendering it as a decision misreports
   * what the wallet actually did. */
  myReactionTimeTo(targetId: string, emoji: string): number | undefined {
    for (const entry of this.reactionIndex.values()) {
      if (entry.targetId === targetId && entry.emoji === emoji && entry.authorPk === this.pubkey) return entry.ts;
    }
    return undefined;
  }

  /** Toggle a reaction: publish kind 7, or retract my existing one via kind 5. */
  async toggleReaction(channelId: string, targetId: string, emoji: string): Promise<void> {
    const mine = this.myReactionTo(targetId, emoji);
    if (mine) {
      const event = await this.wire.publish({
        kind: K.DELETION,
        tags: [["e", mine], ["h", channelId]],
        content: "",
      });
      this.handleDeletion(event);
      return;
    }
    const event = await this.wire.publish({
      kind: K.REACTION,
      tags: [["e", targetId], ["h", channelId]],
      content: emoji,
    });
    this.handleReaction(event, true);
  }

  async pinMessage(channelId: string, targetId: string): Promise<void> {
    const event = await this.wire.publish({
      kind: K.MSG_PIN,
      tags: [["e", targetId], ["h", channelId]],
      content: "",
    });
    this.handleMsgPin(event);
  }

  async unpin(channelId: string, opId: string): Promise<void> {
    const event = await this.wire.publish({
      kind: K.DELETION,
      tags: [["e", opId], ["h", channelId]],
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
  async deleteMessage(channelId: string, targetId: string): Promise<void> {
    const event = await this.wire.publish({
      kind: K.DELETION,
      tags: [["e", targetId], ["h", channelId]],
      content: "",
    });
    this.handleDeletion(event);
  }

  /**
   * Your own message (kind-5 self-delete). A moderator removing SOMEONE
   * ELSE'S message goes through removeMessage() instead — the relay honors
   * a moderator's kind-5 for nobody, so a mod-delete must be the withhold
   * list, not a deletion event.
   */
  canDeleteMessage(msg: Msg): boolean {
    return msg.authorPk === this.pubkey;
  }

  /** May I remove (withhold) this message as a moderator? Not my own. */
  canModerateMessage(msg: Msg): boolean {
    return msg.authorPk !== this.pubkey && this.state.canModerate(this.pubkey);
  }

  async bookmarkMessage(channelId: string, targetId: string): Promise<void> {
    const event = await this.wire.publish({
      kind: K.MSG_BOOKMARK,
      tags: [["e", targetId], ["h", channelId]],
      content: "",
    });
    this.handleMsgBookmark(event);
  }

  async scheduleMessage(channelId: string, sendAt: number, text: string): Promise<void> {
    if (this.wire.signEvent) {
      // Sealed intent: the FINAL message, signed now, dated send_at —
      // whoever executes (relay scheduler, sentinel) releases it
      // verbatim and never needs our key. Format defined in
      // src/protocol/intents.ts (sealContent/parseSealed); inlined here
      // rather than imported because fez-client is its own tsc build
      // with declaration emit and a src-rooted include, so a relative
      // import reaching outside packages/fez-client/src would break
      // the rootDir contract.
      const inner = await this.wire.signEvent({
        kind: K.MESSAGE,
        tags: [["h", channelId]],
        content: text,
        created_at: sendAt,
      });
      await this.wire.publish({
        kind: K.SCHEDULED,
        tags: [["h", channelId], ["send_at", String(sendAt)]],
        content: JSON.stringify({ sealed: inner }),
      });
      return;
    }
    await this.wire.publish({
      kind: K.SCHEDULED,
      tags: [["h", channelId], ["send_at", String(sendAt)]],
      content: text,
    });
  }

  /**
   * Reminders are private data on a public relay — note, fire time, and
   * subject all ride NIP-44 self-encrypted (Buzz built encrypted 30300
   * NIP-ER for exactly this reason; the plaintext remind_at tag was a
   * leak). The sentinel runs with this same key and decrypts to arm.
   */
  /**
   * Write one reminder at its address. Every action funnels here —
   * creating, snoozing, completing and cancelling differ only in the
   * body, because the event is replaceable and the relay keeps the
   * newest at `(pubkey, kind, d)`.
   *
   * The due time is duplicated into a PUBLIC `due` tag. The body stays
   * encrypted; a server can therefore learn WHEN without learning WHAT,
   * which is the only shape in which anything but a live client could
   * ever deliver these.
   */
  private async putReminder(
    id: string,
    body: ReminderBody,
    previousCreatedAt?: number
  ): Promise<void> {
    const createdAt = nextCreatedAt(previousCreatedAt, Math.floor(Date.now() / 1000));
    await this.wire.publish({
      kind: K.REMINDER_V2,
      created_at: createdAt,
      tags: [
        ["d", id],
        ["due", String(body.remind_at ?? 0)],
      ],
      content: await this.wire.encrypt(this.pubkey, JSON.stringify(body)),
    });
  }

  /** A new reminder. Returns its address, which the edits need. */
  async setReminder(remindAt: number, note: string, aboutEventId?: string): Promise<string> {
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await this.putReminder(id, {
      note,
      remind_at: remindAt,
      status: "pending",
      ...(aboutEventId ? { about: aboutEventId } : {}),
    });
    return id;
  }

  /** Push it out to a new time. Still pending — this is not a new reminder. */
  async snoozeReminder(record: ReminderRecord, remindAt: number): Promise<void> {
    await this.putReminder(
      record.key,
      { note: record.note, remind_at: remindAt, status: "pending", ...(record.about ? { about: record.about } : {}) },
      record.createdAt
    );
  }

  /** Done. Kept, and listed apart — you did the thing. */
  async completeReminder(record: ReminderRecord): Promise<void> {
    await this.putReminder(
      record.key,
      { note: record.note, remind_at: record.remindAt, status: "done", ...(record.about ? { about: record.about } : {}) },
      record.createdAt
    );
  }

  /** Abandoned. Gone from the list — you are not going to do the thing. */
  async cancelReminder(record: ReminderRecord): Promise<void> {
    await this.putReminder(
      record.key,
      { note: record.note, remind_at: record.remindAt, status: "cancelled", ...(record.about ? { about: record.about } : {}) },
      record.createdAt
    );
  }

  /**
   * Arm a local timer for an own stored reminder so the client can emit
   * "reminderDue" the moment its remind_at arrives while alive. Not the
   * only deliverer: the sentinel covers app-closed delivery from the
   * same relay-scheduled sealed event. Idempotent per event id.
   */
  private async armReminder(event: { id: string; content: string; tags?: string[][] }): Promise<void> {
    // A v2 reminder is keyed by its ADDRESS, not its event id: snoozing
    // republishes the same address, and keying on the id would leave the
    // old timer armed and fire at BOTH times.
    const address = event.tags?.find((t) => t[0] === "d")?.[1];
    const key = address ?? event.id;
    try {
      const body = JSON.parse(await this.wire.decrypt(this.pubkey, event.content)) as ReminderBody;
      if (typeof body.remind_at !== "number") return;
      // Any write to the address supersedes the timer it had — a snooze
      // moves it, done and cancelled clear it.
      const held = this.reminderTimers.get(key);
      if (held !== undefined) {
        if (address === undefined) return; // legacy: first arm wins, as before
        clearTimeout(held);
        this.reminderTimers.delete(key);
      }
      if (body.status === "done" || body.status === "cancelled") return;
      // Firing never tombstones a reminder (completing is the user's act),
      // so staleness is the refire guard — and it must sit HERE, on the one
      // arming path, because relays replay stored events through the live
      // subscription on every (re)connect, not only through hydrate. A
      // just-missed one (≤60s late) still fires; older history stays silent.
      if (body.remind_at * 1000 < Date.now() - STALE_AFTER_S * 1000) return;
      const remindAt = body.remind_at;
      const note = body.note || "(reminder)";
      // setTimeout's ~24.9-day cap means a long delay gets clamped on
      // arm — waking at the clamp and emitting then would fire early.
      // Recompute what's actually left and re-arm another chunk instead
      // (identical shape to the relay scheduler's fire(), see
      // packages/fez-relay/src/scheduler.ts).
      const wake = () => {
        const remaining = remindAt * 1000 - Date.now();
        if (remaining > 1000) {
          this.reminderTimers.set(key, setTimeout(wake, Math.min(remaining, MAX_TIMER_DELAY_MS)));
          return;
        }
        this.reminderTimers.delete(key);
        this.emit("reminderDue", note);
      };
      this.reminderTimers.set(
        key,
        setTimeout(wake, Math.min(Math.max(0, remindAt * 1000 - Date.now()), MAX_TIMER_DELAY_MS))
      );
    } catch { /* not decryptable/parsable — not ours or legacy-broken */ }
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

  /**
   * The conversation's relay-side channel id: "dm:" + the FULL participant
   * set (peers + self), sorted. Both sides derive the same id with no
   * event to publish; the relay's dm gate reads the participants straight
   * out of it. Reactions/edits/deletions h-tag this — message bodies stay
   * gift-wrapped and never touch it.
   */
  dmChannelId(key: string): string {
    return "dm:" + [...new Set([...this.dmPeers(key), this.pubkey])].sort().join("+");
  }

  /** Find a DM message by rumor id across conversations (small N — convos cap at 100 msgs). */
  private dmMsgById(id: string): { msg: DmMessage; channelId: string } | undefined {
    for (const [key, convo] of this.dmConvos) {
      const msg = convo.msgs.find((m) => m.id === id);
      if (msg) return { msg, channelId: this.dmChannelId(key) };
    }
    return undefined;
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
        void (async () =>
          this.wire.publish({
            kind: K.READ_STATE,
            tags: [["d", channelId]],
            content: await this.wire.encrypt(this.pubkey, JSON.stringify({ last_read: this.lastReadByChannel.get(channelId) })),
          }))().catch(() => {});
      }, 5000)
    );
  }

  async docVersions(channelId: string): Promise<WireEvent[]> {
    const events = await this.queryDocVersions({ kinds: [K.DOC], "#h": [channelId], limit: 200 });
    return orderVersions(
      events
        .filter((e) => this.state.isMember(e.pubkey))
        .filter((e) => !e.tags.some((t) => t[0] === "d")) // named pages aren't the channel doc
    );
  }

  private async queryDocVersions(filter: WireFilter): Promise<WireEvent[]> {
    const { events, failures } = await this.queryHistory([filter]);
    if (failures.length) throw new Error("Could not read the current document version; retry before saving.");
    const merged = new Map([...this.docEvents.values(), ...events].map(event => [event.id, event]));
    return [...merged.values()].filter(event =>
      (!filter["#h"] || event.tags.some(t => t[0] === "h" && filter["#h"]!.includes(t[1]))) &&
      (!filter["#d"] || event.tags.some(t => t[0] === "d" && filter["#d"]!.includes(t[1])))
    );
  }

  async publishDoc(channelId: string, content: string, baseId?: string): Promise<WireEvent> {
    const latest = (await this.docVersions(channelId)).at(-1);
    assertDocBase(latest, baseId);
    const event = await this.wire.publish({
      kind: K.DOC,
      created_at: Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1),
      tags: [["h", channelId], ...(baseId ? [["base", baseId]] : [])],
      content,
    });
    this.handleDocEvent(event);
    return event;
  }

  /** Checkbox state for a doc — latest event per item wins. */
  async docTasks(opts: { channelId?: string; slug?: string }): Promise<Map<string, TaskState>> {
    const filter = opts.slug
      ? { kinds: [K.DOC_TASK], "#d": [opts.slug], limit: 500 }
      : { kinds: [K.DOC_TASK], "#h": [opts.channelId ?? ""], limit: 500 };
    const events = (await this.wire.query([filter])).filter(
      (e) => this.state.isMember(e.pubkey)
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
    itemText: string,
    done: boolean,
    slug?: string
  ): Promise<void> {
    await this.wire.publish({
      kind: K.DOC_TASK,
      tags: [
        ["h", channelId],
                ...(slug ? [["d", slug]] : []),
        ["t", taskKey(itemText)],
        ["done", done ? "1" : "0"],
      ],
      content: "",
    });
  }

  /** Publish an artifact into a channel AS THE USER — the same 40300 shape
   * agents emit, so it lands as a normal tool handle others can open and
   * keep. No root tag: a shared tool is channel-level, not thread-scoped. */
  async publishArtifact(channelId: string, artifact: { type: string; title?: string; content: string }): Promise<void> {
    await this.wire.publish({
      kind: K.ARTIFACT,
      tags: [
        ["h", channelId],
        ["type", artifact.type],
      ],
      content: JSON.stringify(artifact),
    });
  }

  /** Named wiki pages in joined communities, keyed `${communityId}:${slug}`. */
  wikiDocs(): ReadonlyMap<string, WikiDoc> {
    return this.wikiMap;
  }

  async wikiVersions(slug: string): Promise<WireEvent[]> {
    const events = await this.queryDocVersions({ kinds: [K.DOC], "#d": [slug], limit: 200 });
    return orderVersions(
      // Workspace-scoped: a page belongs to the workspace, not to the
      // channel it happened to be written from. The relay IS that scope,
      // so there is no tag left to check.
      events.filter((e) => this.state.isMember(e.pubkey))
    );
  }

  /**
   * Comments on a doc/page, anchored by LINE TEXT (not line number) so a
   * note stays attached when lines shift above it. Returns threads:
   * a root comment plus its replies, with resolution folded in.
   */
  async docComments(opts: { channelId?: string; slug?: string }): Promise<DocCommentThread[]> {
    const filter = opts.slug
      ? { kinds: [K.DOC_COMMENT], "#d": [opts.slug], limit: 500 }
      : { kinds: [K.DOC_COMMENT], "#h": [opts.channelId ?? ""], limit: 500 };
    const events = new Map([...this.docCommentEvents.values(), ...await this.wire.query([filter])].map(event => [event.id, event]));
    for (const event of events.values()) if (this.state.isMember(event.pubkey)) this.docCommentEvents.set(event.id, event);
    return docCommentThreads([...events.values()].filter(event => this.state.isMember(event.pubkey)), opts);
  }

  private handleDocComment(event: WireEvent): void {
    if (this.docCommentEvents.has(event.id) || !this.state.isMember(event.pubkey)) return;
    const channelId = event.tags.find(t => t[0] === "h")?.[1];
    if (!channelId) return;
    this.docCommentEvents.set(event.id, event);
    this.emit("docCommentsChanged", channelId);
  }

  /** Leave a comment (or reply). Mentions are p-tagged so agents get summoned. */
  async publishDocComment(
    channelId: string,
    text: string,
    opts: { anchor?: string; anchorContext?: DocAnchor; writerPk?: string; slug?: string; parentId?: string; mentionPks?: string[]; resolve?: boolean } = {}
  ): Promise<WireEvent> {
    if (opts.writerPk && !/^[a-f0-9]{64}$/.test(opts.writerPk)) throw new Error("Invalid writer pubkey");
    if (opts.parentId) await this.docComments({ channelId, slug: opts.slug });
    const related = [...this.docCommentEvents.values()].filter(event => event.id === opts.parentId || event.tags.some(t => t[0] === "e" && t[1] === opts.parentId));
    const event = await this.wire.publish({
      kind: K.DOC_COMMENT,
      created_at: Math.max(Math.floor(Date.now() / 1000), ...related.map(event => event.created_at + 1)),
      tags: [
        ["h", channelId],
        ...(opts.slug ? [["d", opts.slug]] : []),
        ...(opts.anchor ? [["anchor", opts.anchor.slice(0, 300)]] : []),
        ...(opts.anchorContext ? [["anchor-context", JSON.stringify(opts.anchorContext)]] : []),
        ...(opts.writerPk ? [["writer", opts.writerPk]] : []),
        ...(opts.parentId ? [["e", opts.parentId]] : []),
        ...(opts.resolve !== undefined ? [["resolved", opts.resolve ? "1" : "0"]] : []),
        ...(opts.mentionPks ?? []).map((pk) => ["p", pk]),
      ],
      content: text,
    });
    this.handleDocComment(event);
    return event;
  }

  /** An existing page's address stays stable even when its displayed title changes. */
  async publishWikiDoc(channelId: string, name: string, content: string, baseId?: string, slug = wikiSlug(name)): Promise<WireEvent> {
    if (!slug || wikiSlug(slug) !== slug) throw new Error("Invalid document address.");
    const latest = (await this.wikiVersions(slug)).at(-1);
    assertDocBase(latest, baseId);
    const event = await this.wire.publish({
      kind: K.DOC,
      created_at: Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1),
      tags: [
        ["h", channelId],
        ["d", slug],
        ["title", name.trim()],
        ...(baseId ? [["base", baseId]] : []),
      ],
      content,
    });
    this.handleDocEvent(event);
    return event;
  }

  /**
   * Claim this relay as a workspace: publish the first channel and a
   * roster naming yourself owner.
   *
   * There is no workspace event to create — the relay IS the workspace,
   * and it already exists. This only writes the things a workspace needs
   * to be usable. It is why onboarding can no longer mint a duplicate
   * "Home" on every run: there is nothing to mint.
   */
  async claimWorkspace(firstChannel = "general"): Promise<{ channelId: string }> {
    if (!this.state.isOwner(this.pubkey)) {
      throw new Error("configure this relay's owner before initializing the workspace");
    }
    if (this.state.workspace.channels.size > 0) {
      throw new Error("this workspace already has channels — add a channel or join a different relay");
    }
    firstChannel = firstChannel.trim();
    if (!firstChannel) throw new Error("channel name is required");
    const channelId = "bootstrap-general";
    const channelEvent = await this.wire.publish({
      kind: K.CHANNEL,
      tags: [["d", channelId]],
      content: JSON.stringify({ name: firstChannel, visibility: "open" }),
    });
    await this.publishRoster(() => {});
    this.state.absorb(channelEvent);
    this.state.scope = { channelId };
    this.state.save();
    this.resubscribe();
    this.emit("channelsChanged");
    return { channelId };
  }

  /** Owner adds or reuses a channel by name; scope moves there. */
  async createChannel(name: string): Promise<string> {
    if (!this.state.isOwner(this.pubkey)) throw new Error("only the workspace owner can add channels");
    const channelId = (await this.ensureChannel({ name }))!;
    this.setScope(channelId);
    return channelId;
  }

  /**
   * Archive (or unarchive) a channel — the only "remove" a channel gets.
   * A channel's events are real history, so we never delete it; the owner
   * republishes its 47101 with `archived` set, latest-wins carries it, and
   * every client hides an archived channel. Reversible: pass false to
   * bring it back. Only the owner may sign a channel, so only the owner
   * may archive one — the same rule as creating it.
   */
  async archiveChannel(channelId: string, archived = true): Promise<void> {
    if (!this.state.isOwner(this.pubkey)) throw new Error("only the workspace owner can archive a channel");
    const channel = this.state.workspace.channels.get(channelId);
    if (!channel) throw new Error("no such channel");
    // Republish the whole channel: latest-wins REPLACES it, so name,
    // source and meta must ride along or they'd be dropped.
    const content: Record<string, unknown> = { name: channel.name };
    if (channel.visibility) content.visibility = channel.visibility;
    if (channel.source) content.source = channel.source;
    if (channel.meta) content.meta = channel.meta;
    if (archived) content.archived = true;
    const event = await this.wire.publish({
      kind: K.CHANNEL,
      tags: [["d", channelId]],
      content: JSON.stringify(content),
      created_at: Math.max(Math.floor(Date.now() / 1000), channel.createdAt + 1),
    });
    this.state.absorb(event);
    // Don't sit in a channel you just archived.
    if (archived && this.state.scope?.channelId === channelId) this.state.scope = null;
    this.state.save();
    this.resubscribe();
    this.emit("channelsChanged");
  }

  /**
   * The channel for a thing, opening it if it isn't open.
   *
   * Like `makeChannels().ensure` in the CLI's src/protocol/channels.ts,
   * matches by name unless an explicit ID is supplied. Only the
   * owner may sign one into being. It lives here as well because the
   * desktop bundle deliberately does not depend on the CLI package, and
   * the alternative was a second copy inside the GUI extension loader.
   * @fezchat/client is the layer the TUI, the desktop and extensions all
   * already share; a vocabulary that has to reach all three belongs at
   * the widest point they have in common, not copied to each.
   *
   * Reads the channels the client has already absorbed rather than
   * querying: state is live and the wire is not free.
   */
  async ensureChannel(spec: {
    name: string;
    source?: string;
    meta?: Record<string, string>;
    visibility?: "open" | "closed";
    /**
     * Authoritative channel ID: updates resolve it without a name fallback.
     * For bootstrap-created channels: two racing
     * creates with the same id CONVERGE (latest event with one d-tag
     * wins) instead of minting two channels — the only duplicate-proof
     * shape, because no query-first guard survives a cold relay
     * answering empty (review finding F6).
     */
    id?: string;
  }): Promise<string | undefined> {
    const name = spec.name.trim();
    if (!name) throw new Error("channel name cannot be empty");
    const existing = spec.id === undefined
      ? this.state.findChannelByName(name)
      : this.state.workspace.channels.get(spec.id);
    const channelName = spec.id === undefined ? existing?.name ?? name : name;
    const source = cleanSource(spec.source ?? existing?.source);
    const meta = spec.meta ?? existing?.meta;
    const visibility = spec.visibility ?? existing?.visibility ?? "open";
    const content = JSON.stringify({
      name: channelName,
      visibility,
      ...(source ? { source } : {}),
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
      ...(existing?.archived ? { archived: true } : {}),
    });

    if (existing) {
      // Re-signing the same `d` is an edit in place. META COUNTS: a repo
      // learning what it protects must be able to say so even though its
      // source already matched, which is the bug the CLI copy already
      // paid for.
      const changed =
        channelName !== existing.name ||
        source !== existing.source ||
        visibility !== (existing.visibility ?? "open") ||
        JSON.stringify(meta ?? {}) !== JSON.stringify(existing.meta ?? {});
      if (changed && this.state.isOwner(this.pubkey)) {
        this.state.absorb(await this.wire.publish({
          kind: K.CHANNEL, tags: [["d", existing.id]], content,
          created_at: Math.max(Math.floor(Date.now() / 1000), existing.createdAt + 1),
        }));
        this.state.save();
        this.emit("channelsChanged");
      }
      // A non-owner cannot EDIT, but the channel exists and is theirs to
      // use — returning undefined here surfaced as a false "only the
      // owner can open a channel" for a working channel (review F8).
      // Same contract as src/channels.ts: the edit is skipped, the id is
      // truth.
      return existing.id;
    }

    // Saying so here saves every caller from discovering it as a silent
    // no-op that looks like success.
    if (!this.state.isOwner(this.pubkey)) return undefined;
    // Share in-flight creates within this client. Cross-client bootstrap
    // races still need a fixed ID, as documented on spec.id.
    const key = JSON.stringify([this.state.workspace.relay, spec.id === undefined ? "name" : "id", spec.id ?? name.toLowerCase()]);
    const pending = this.pendingChannels.get(key);
    if (pending) {
      await pending;
      return this.ensureChannel(spec);
    }
    const channelId = spec.id ?? crypto.randomUUID();
    const creation = (async () => {
      this.state.absorb(await this.wire.publish({ kind: K.CHANNEL, tags: [["d", channelId]], content }));
      this.state.save();
      this.resubscribe();
      this.emit("channelsChanged");
      return channelId;
    })();
    this.pendingChannels.set(key, creation);
    try {
      return await creation;
    } finally {
      this.pendingChannels.delete(key);
    }
  }

  /**
   * What the relay says it is, including whatever its extensions
   * advertised. Undefined before the workspace is opened, or when the
   * backend serves no NIP-11 at all.
   */
  relayInfo(): RelayInfoDoc | undefined {
    return this.relayInfoDoc;
  }

  /**
   * A NIP-98 header for `url` — or undefined when the wire cannot sign.
   * Callers treat undefined as "this surface is unavailable", the same
   * honest degradation as a missing relayInfo.
   */
  async httpAuthHeader(url: string, method: string): Promise<string | undefined> {
    return this.wire.httpAuth?.(url, method);
  }

  /** All channels, including archived ones; optionally filtered by maker. */
  channelsFrom(source?: string): Omit<Channel, "createdAt">[] {
    return [...this.state.workspace.channels.values()]
      .filter((c) => source === undefined || c.source === source)
      .map((c) => ({ id: c.id, name: c.name, source: c.source, meta: c.meta, archived: c.archived, visibility: c.visibility }));
  }

  /**
   * Point this client at a workspace and pull its state.
   *
   * The owner comes from the relay's NIP-11 document, and it has to
   * arrive BEFORE any 47101/47102 is absorbed — the state model rejects
   * everything while the workspace is unclaimed, so ordering here is
   * load-bearing, not incidental.
   */
  async openWorkspace(relay: string): Promise<boolean> {
    this.state.open(relay);
    const info = await this.wire.relayInfo?.(relay);
    this.relayInfoDoc = info;
    this.state.describe({ name: info?.name, owner: info?.pubkey });
    await this.syncWorkspace();
    this.resubscribe();
    this.emit("channelsChanged");
    return !!this.state.workspace.owner;
  }

  /** Every workspace in the rail. Switching between them never drops one. */
  workspaces(): { relay: string; name: string; active: boolean }[] {
    return this.state.known.map((w) => ({
      relay: w.relay,
      name: w.name ?? w.relay,
      active: w.relay === this.state.workspace.relay,
    }));
  }

  /** Drop a workspace from the rail. Local only — the workspace is untouched. */
  forgetWorkspace(relay: string): void {
    this.state.forget(relay);
    this.emit("channelsChanged");
  }

  /** Scope to a channel by name in this workspace; loads its history window. */
  async joinChannel(name: string): Promise<{ channelId: string; name: string } | undefined> {
    const channel = this.state.findChannelByName(name);
    if (!channel) return undefined;
    this.state.scope = { channelId: channel.id };
    this.state.save();
    this.emit("channelsChanged");
    await this.loadChannelHistory(channel.id);
    return { channelId: channel.id, name: channel.name };
  }

  leaveScope(): void {
    this.state.scope = null;
    this.state.save();
    this.emit("channelsChanged");
  }

  setScope(channelId: string): void {
    this.state.scope = { channelId };
    this.state.save();
    this.emit("channelsChanged");
  }

  /**
   * Roster updates must strictly advance the winning 47102's created_at —
   * two updates in the same second would otherwise tie and resolve by id,
   * surprising the owner who published second (Buzz bumps for the same
   * reason).
   */
  private nextRosterCreatedAt(): number {
    return Math.max(Math.floor(Date.now() / 1000), this.state.workspace.rosterCreatedAt + 1);
  }

  private rosterWrite: Promise<void> = Promise.resolve();

  /** Serialize read-modify-publish so overlapping invitations cannot drop members. */
  private publishRoster(update: (members: Map<string, Role>) => void): Promise<void> {
    const workspace = this.state.workspace;
    const write = this.rosterWrite.then(async () => {
      if (this.state.workspace !== workspace) throw new Error("workspace changed — try again");
      const members = new Map(workspace.members);
      update(members);
      // Agents gate mentions on the roster's p-tags alone. Every write
      // must retain the owner, even when hydration omitted their key.
      const owner = workspace.owner;
      if (owner) members.set(owner, "owner");
      const event = await this.wire.publish({
        kind: K.MEMBERSHIP,
        tags: [["d", K.ROSTER_D], ...[...members.entries()].map(([pk, r]) => ["p", pk, r])],
        content: "",
        created_at: this.nextRosterCreatedAt(),
      });
      if (this.state.workspace === workspace) {
        this.state.absorb(event);
        this.emit("channelsChanged");
      }
    });
    this.rosterWrite = write.catch(() => {});
    return write;
  }

  /**
   * Invite someone to the WORKSPACE — they land and see every channel.
   * That is the flat model's promise, and the reason there is no
   * per-channel invite to get wrong.
   */
  async invite(pubkey: string, role: Role): Promise<string> {
    pubkey = pubkey.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("invalid public key — use a 64-character hex key");
    if (!["owner", "admin", "member", "bot"].includes(role)) throw new Error("invalid member role");
    if (role === "owner" && pubkey !== this.state.workspace.owner) throw new Error("the workspace owner is fixed");
    await this.publishRoster((members) => {
      if (!this.state.isOwner(this.pubkey)) throw new Error("only the workspace owner can invite");
      if (this.state.isBanned(pubkey)) throw new Error("this member is banned — unban them before inviting");
      if (!members.has(pubkey)) members.set(pubkey, role);
    });
    return this.displayName(pubkey);
  }

  /**
   * Owner-signed attestation (47006): "this is my agent." The sentinel
   * honors summons from the owner OR attested siblings, so a guide that
   * brings teammates in by mention needs this on its key — an unattested
   * agent's mentions die in silence.
   */
  async attestAgent(agentPk: string): Promise<void> {
    if (!this.state.isOwner(this.pubkey)) throw new Error("only the workspace owner can attest an agent");
    await this.wire.publish({ kind: K.AGENT_ATTESTATION, tags: [["p", agentPk]], content: "" });
  }

  /** Publish a chit — a signed note that this agent's work was accepted. */
  async chitAgent(agentPk: string, opts: { note: string; workId?: string; channelId?: string }): Promise<void> {
    const tags: string[][] = [["p", agentPk]];
    if (opts.workId) tags.push(["e", opts.workId]);
    if (opts.channelId) tags.push(["h", opts.channelId]);
    await this.wire.publish({ kind: K.CHIT, tags, content: opts.note });
  }

  /** Vouch for an agent. Addressable: latest per signer wins. */
  async saltAgent(agentPk: string, note = "trusted"): Promise<void> {
    await this.wire.publish({ kind: K.SALT, tags: [["d", agentPk], ["p", agentPk]], content: note });
  }

  /** Revoke your vouch — republish the address empty. */
  async unsaltAgent(agentPk: string): Promise<void> {
    await this.wire.publish({ kind: K.SALT, tags: [["d", agentPk], ["p", agentPk]], content: "" });
  }

  /** One-shot salt evidence panel for an agent, from THIS viewer's vantage. */
  async saltPanel(agentPk: string): Promise<SaltPanel> {
    const [chits, vouches, pays, attestIn, myAttested, myVouches] = await Promise.all([
      this.wire.query([{ kinds: [K.CHIT], "#p": [agentPk], limit: 500 }]),
      this.wire.query([{ kinds: [K.SALT], "#d": [agentPk], limit: 500 }]),
      this.wire.query([{ kinds: [K.PAYMENT_RECEIPT], "#p": [agentPk], limit: 500 }]),
      this.wire.query([{ kinds: [K.AGENT_ATTESTATION], "#p": [agentPk], limit: 200 }]),
      this.wire.query([{ kinds: [K.AGENT_ATTESTATION], authors: [this.pubkey], limit: 200 }]),
      this.wire.query([{ kinds: [K.SALT], authors: [this.pubkey], limit: 500 }]),
    ]);
    const owners = [...new Set(attestIn.map((e) => e.pubkey))];
    const siblingEvents = owners.length
      ? await this.wire.query([{ kinds: [K.AGENT_ATTESTATION], authors: owners, limit: 500 }])
      : [];

    const p = (e: { tags: string[][] }, name: string) => e.tags.find((t) => t[0] === name)?.[1];
    const evidence = chitEvidence(agentPk, [...chits, ...pays]);
    // Latest vouch per signer; empty content = revoked.
    const latestVouch = new Map<string, (typeof vouches)[number]>();
    for (const v of vouches) {
      const prev = latestVouch.get(v.pubkey);
      if (!prev || v.created_at > prev.created_at) latestVouch.set(v.pubkey, v);
    }
    for (const v of latestVouch.values()) {
      if (!v.content) continue;
      evidence.push({ signer: v.pubkey, kind: "vouch", note: v.content, at: v.created_at, moneyBacked: false });
    }

    const attestations = [...attestIn, ...siblingEvents]
      .map((e) => ({ owner: e.pubkey, agent: p(e, "p") ?? "" }))
      .filter((a) => a.agent);
    const mine = new Set(myAttested.map((e) => p(e, "p")).filter(Boolean) as string[]);
    const vouched = new Set(myVouches.filter((e) => e.content).map((e) => p(e, "d")).filter(Boolean) as string[]);

    return deriveSalt({
      agent: agentPk,
      viewer: this.pubkey,
      evidence,
      attestations,
      isViewerAgent: (pk) => pk === this.pubkey || mine.has(pk),
      inViewerCircle: (pk) => this.state.isMember(pk) || vouched.has(pk),
    });
  }

  /**
   * Guard rail: an admin (not the owner) may not act on the owner or on
   * another admin. Only the owner outranks an admin.
   */
  private assertCanTarget(target: string): void {
    if (this.state.isOwner(this.pubkey)) return; // the owner may act on anyone
    if (target === this.state.workspace.owner || this.state.roleOf(target) === "admin") {
      throw new Error("admins can't act on the owner or other admins");
    }
  }

  /** A moderator republishes the roster without the pubkey. Their history stays. */
  async kick(pubkey: string): Promise<string> {
    await this.publishRoster((members) => {
      if (!this.state.canModerate(this.pubkey)) throw new Error("only a moderator can remove members");
      if (pubkey === this.state.workspace.owner) {
        throw new Error("the owner can't be removed — the workspace is rooted in their signature");
      }
      this.assertCanTarget(pubkey);
      if (!members.delete(pubkey)) throw new Error("not a member of this workspace");
    });
    return this.displayName(pubkey);
  }

  /** Owner-only: promote a member to admin (or demote back to member). */
  async promote(pubkey: string): Promise<void> {
    await this.publishRoster((members) => {
      if (!this.state.isOwner(this.pubkey)) throw new Error("only the workspace owner can change roles");
      if (pubkey === this.state.workspace.owner) throw new Error("the owner's role is fixed");
      if (!members.has(pubkey)) throw new Error("not a member of this workspace");
      members.set(pubkey, "admin");
    });
  }

  async demote(pubkey: string): Promise<void> {
    await this.publishRoster((members) => {
      if (!this.state.isOwner(this.pubkey)) throw new Error("only the workspace owner can change roles");
      if (members.get(pubkey) !== "admin") throw new Error("not an admin");
      members.set(pubkey, "member");
    });
  }

  /**
   * Ban/unban (owner-only): republish the workspace's 30047 with the
   * pubkey added/removed, created_at strictly advancing (same monotonic
   * rule as rosters). A ban leaves the roster untouched — the banned
   * pubkey is simply treated as a non-member everywhere until unbanned.
   */
  private async publishBanList(
    banned: Map<string, number | undefined>,
    reasons: Map<string, string>
  ): Promise<void> {
    if (!this.state.canModerate(this.pubkey)) throw new Error("only a moderator can do this");
    // ["p", pk, until|"", reason] — positional, so a reason without an
    // expiry keeps "" in the until slot. The reason lives INSIDE the
    // signed edict: the audit trail is the record itself.
    const tag = (pk: string, until: number | undefined) => {
      const reason = reasons.get(pk);
      if (reason) return ["p", pk, until ? String(until) : "", reason];
      return until ? ["p", pk, String(until)] : ["p", pk];
    };
    const event = await this.wire.publish({
      kind: K.BAN_LIST,
      tags: [["d", K.BANS_D], ...[...banned].map(([pk, until]) => tag(pk, until))],
      content: "",
      created_at: Math.max(Math.floor(Date.now() / 1000), this.state.workspace.banListCreatedAt + 1),
    });
    this.state.absorb(event);
    this.emit("channelsChanged");
  }

  /** Ban permanently, or (with `until` unix-seconds) time out temporarily. */
  async banUser(pubkey: string, until?: number, reason?: string): Promise<string> {
    if (pubkey === this.state.workspace.owner) throw new Error("the owner can't be banned");
    this.assertCanTarget(pubkey);
    const banned = new Map(this.state.workspace.banned);
    banned.set(pubkey, until);
    const reasons = new Map(this.state.workspace.banReasons);
    if (reason) reasons.set(pubkey, reason);
    else reasons.delete(pubkey);
    await this.publishBanList(banned, reasons);
    return this.displayName(pubkey);
  }

  async unbanUser(pubkey: string): Promise<string> {
    const banned = new Map(this.state.workspace.banned);
    if (!banned.delete(pubkey)) throw new Error("not banned");
    const reasons = new Map(this.state.workspace.banReasons);
    reasons.delete(pubkey);
    await this.publishBanList(banned, reasons);
    return this.displayName(pubkey);
  }

  /** Republish the 30047 d=removed list with the id added/removed. */
  private async publishRemovedList(removed: Set<string>, reasons: Map<string, string>): Promise<void> {
    if (!this.state.canModerate(this.pubkey)) throw new Error("only a moderator can do this");
    const event = await this.wire.publish({
      kind: K.BAN_LIST,
      tags: [
        ["d", K.REMOVED_D],
        // ["e", id, reason] — the reason is part of the signed record.
        ...[...removed].map((id) => (reasons.get(id) ? ["e", id, reasons.get(id)!] : ["e", id])),
      ],
      content: "",
      created_at: Math.max(Math.floor(Date.now() / 1000), this.state.workspace.removedCreatedAt + 1),
    });
    this.state.absorb(event);
    this.applyRemovals();
    this.emit("channelsChanged");
  }

  /**
   * Tombstone any in-memory message now on the removed list. The relay
   * already withholds removed events from REQ, so a fresh load never shows
   * them; this covers messages already on screen when a moderator acts.
   * ponytail: restore is reflected on reload (content is cleared here), not
   * live in-session — retain original content if live un-tombstone matters.
   */
  private applyRemovals(): void {
    for (const [channelId, list] of this.messagesByChannel) {
      for (const msg of list) {
        if (this.state.isRemoved(msg.id) && msg.deletedBy !== "moderator") {
          msg.deletedBy = "moderator";
          msg.content = "";
          this.emit("messageDeleted", channelId, msg);
          this.emit("metaChanged", channelId, msg.id);
        }
      }
    }
  }

  /** Withhold a message for everyone (reversible). Any moderator may do this. */
  async removeMessage(eventId: string, reason?: string): Promise<void> {
    const removed = new Set(this.state.workspace.removed);
    removed.add(eventId);
    const reasons = new Map(this.state.workspace.removalReasons);
    if (reason) reasons.set(eventId, reason);
    else reasons.delete(eventId);
    await this.publishRemovedList(removed, reasons);
  }

  /** Restore a previously-removed message. */
  async restoreMessage(eventId: string): Promise<void> {
    const removed = new Set(this.state.workspace.removed);
    if (!removed.delete(eventId)) throw new Error("not removed");
    const reasons = new Map(this.state.workspace.removalReasons);
    reasons.delete(eventId);
    await this.publishRemovedList(removed, reasons);
  }

  /** The moderator set: the owner plus every admin on the current roster. */
  moderators(): string[] {
    const ws = this.state.workspace;
    const mods = ws.owner ? [ws.owner] : [];
    for (const [pk, role] of ws.members) {
      if (role === "admin" && pk !== ws.owner) mods.push(pk);
    }
    return mods;
  }

  /**
   * Report a message to the moderators — one kind-1984 per moderator, the
   * reason NIP-44'd to that recipient. Observers learn only "someone
   * reported something here"; the reporter's identity and reason reach
   * moderators alone.
   */
  async reportMessage(channelId: string, targetId: string, authorPk: string, reason: string): Promise<void> {
    const mods = this.moderators();
    if (mods.length === 0) throw new Error("this workspace has no moderators to report to");
    for (const mod of mods) {
      await this.wire.publish({
        kind: K.REPORT,
        tags: [["p", mod], ["e", targetId], ["h", channelId]],
        content: await this.wire.encrypt(mod, JSON.stringify({ reason, author: authorPk })),
      });
    }
  }

  /**
   * The moderation queue: reports addressed to me, grouped by target.
   * Resolution is DERIVED — a removed target or banned author is handled,
   * a dismissed target was looked at and let stand — so acting once
   * clears the entry for every moderator without extra bookkeeping.
   */
  async listReports(): Promise<ReportEntry[]> {
    const events = await this.wire.query([{ kinds: [K.REPORT], "#p": [this.pubkey], limit: 500 }]);
    const byTarget = new Map<string, ReportEntry>();
    for (const event of events.sort((a, b) => b.created_at - a.created_at)) {
      const targetId = event.tags.find((t) => t[0] === "e")?.[1];
      if (!targetId) continue;
      let body: { reason?: string; author?: string };
      try {
        body = JSON.parse(await this.wire.decrypt(event.pubkey, event.content)) as typeof body;
      } catch {
        continue; // not addressed to me
      }
      const entry = byTarget.get(targetId) ?? {
        targetId,
        channelId: event.tags.find((t) => t[0] === "h")?.[1],
        authorPk: body.author,
        reporters: [],
      };
      entry.reporters.push({ pk: event.pubkey, reason: body.reason ?? "", at: event.created_at });
      byTarget.set(targetId, entry);
    }
    const ws = this.state.workspace;
    for (const entry of byTarget.values()) {
      if (this.state.isRemoved(entry.targetId)) {
        entry.resolved = { action: "removed", by: ws.removedSigner };
      } else if (entry.authorPk && this.state.isBanned(entry.authorPk)) {
        entry.resolved = { action: "banned", by: ws.banListSigner };
      } else if (this.state.isDismissed(entry.targetId)) {
        entry.resolved = { action: "dismissed", by: ws.dismissedSigner };
      }
    }
    return [...byTarget.values()].sort((a, b) => (b.reporters[0]?.at ?? 0) - (a.reporters[0]?.at ?? 0));
  }

  /** Looked at it, letting it stand — clears the entry for every moderator. */
  async dismissReport(targetId: string): Promise<void> {
    if (!this.state.canModerate(this.pubkey)) throw new Error("only a moderator can do this");
    const dismissed = new Set(this.state.workspace.dismissed);
    dismissed.add(targetId);
    const event = await this.wire.publish({
      kind: K.BAN_LIST,
      tags: [["d", K.DISMISSED_D], ...[...dismissed].map((id) => ["e", id])],
      content: "",
      created_at: Math.max(Math.floor(Date.now() / 1000), this.state.workspace.dismissedCreatedAt + 1),
    });
    this.state.absorb(event);
    this.emit("channelsChanged");
  }

  /**
   * The personal plane: hide someone from YOUR view. No authority, no
   * roster, no relay policy — a self-encrypted 30078 d="mutes" record
   * (same account-data pattern as read state), so it follows your key
   * across devices and the muted person can never tell.
   */
  isMutedByMe(pk: string): boolean {
    return this.mutedByMe.has(pk);
  }

  async mutePerson(pk: string): Promise<void> {
    if (pk === this.pubkey) throw new Error("you can't mute yourself");
    this.mutedByMe.add(pk);
    await this.publishMutes();
  }

  async unmutePerson(pk: string): Promise<void> {
    if (!this.mutedByMe.delete(pk)) throw new Error("not muted");
    await this.publishMutes();
  }

  private async publishMutes(): Promise<void> {
    await this.wire.publish({
      kind: K.READ_STATE,
      tags: [["d", K.MUTES_D]],
      content: await this.wire.encrypt(this.pubkey, JSON.stringify({ muted: [...this.mutedByMe] })),
    });
    this.emit("channelsChanged");
  }

  /**
   * An extension's own configuration, on the relay, encrypted to you.
   *
   * The seam exists because the alternative is every extension deriving
   * this for itself: NIP-78's kind, a `d` tag that must not collide with
   * fez's own read state (which uses a channel UUID on the same kind),
   * and self-encryption. Getting any of those subtly wrong is silent —
   * a config nobody can read, or one that overwrites something else.
   *
   * A dotfile would have been simpler and is what fez-github started
   * with, but a webview has no filesystem, so config on disk can never
   * be edited from the desktop app. On the relay it is editable, and it
   * follows you to another machine for free.
   *
   * SELF-ENCRYPTED, always. Config names things — which repos, which
   * host, which project — and workspace members can read the relay.
   * Secrets do not go here regardless: those live in the keychain.
   */
  async extensionConfig<T>(extension: string): Promise<T | undefined> {
    const events = await this.wire.query([
      { kinds: [K.APP_DATA], authors: [this.pubkey], "#d": [`ext:${extension}`], limit: 5 },
    ]);
    // Newest wins: a replaceable kind SHOULD leave one, but a relay that
    // kept two must not be resolved by whichever arrived first.
    const newest = [...events].sort((a, b) => b.created_at - a.created_at)[0];
    if (!newest) return undefined;
    try {
      return JSON.parse(await this.wire.decrypt(this.pubkey, newest.content)) as T;
    } catch {
      return undefined; // not ours to read, or malformed
    }
  }

  async saveExtensionConfig(extension: string, config: unknown): Promise<void> {
    await this.wire.publish({
      kind: K.APP_DATA,
      tags: [["d", `ext:${extension}`]],
      content: await this.wire.encrypt(this.pubkey, JSON.stringify(config)),
    });
  }

  async queryEngrams(agentPk: string): Promise<WireEvent[]> {
    return this.wire.query([{ kinds: [30174], authors: [agentPk], "#p": [this.pubkey] }]);
  }
  async decryptFrom(peerPk: string, ciphertext: string): Promise<string> {
    return this.wire.decrypt(peerPk, ciphertext);
  }

  // ── History windows (Buzz's channel window, dumb-relay-shaped) ─────────

  historyState(channelId: string): Readonly<HistoryLoadState> {
    return this.historyByChannel.get(channelId) ?? { status: "idle", operation: "recent" };
  }

  private beginHistory(channelId: string, operation: HistoryLoadState["operation"]): HistoryLoadState {
    const state: HistoryLoadState = { status: "loading", operation };
    this.historyByChannel.set(channelId, state);
    this.emit("historyChanged", channelId);
    return state;
  }

  private finishHistory(channelId: string, loading: HistoryLoadState, failures: WireQueryResult["failures"]): void {
    // A slower prior request must not replace the status of a newer retry.
    if (this.historyByChannel.get(channelId) !== loading) return;
    this.historyByChannel.set(channelId, { operation: loading.operation,
      status: failures.length ? "error" : "ready",
      partial: failures.length > 0 && this.messages(channelId).length > 0,
      error: failures.length ? [...new Set(failures.map(f => `${f.url}: ${f.reason}`))].join("; ") : undefined,
    });
    this.emit("historyChanged", channelId);
  }

  private async queryHistory(filters: WireFilter[]): Promise<WireQueryResult> {
    try {
      return this.wire.queryWithStatus
        ? await this.wire.queryWithStatus(filters)
        : { events: await this.wire.query(filters), failures: [] };
    } catch (err) {
      return { events: [], failures: [{ url: this.wire.relays?.[0] ?? "relay", reason: err instanceof Error ? err.message : String(err) }] };
    }
  }

  async loadChannelHistory(channelId: string, threadRoot?: string): Promise<void> {
    const loading = this.beginHistory(channelId, "recent");
    // Artifacts backfill rides alongside — failures never block messages.
    void this.wire
      .query([{ kinds: [K.ARTIFACT], "#h": [channelId], limit: 50 }])
      .then((events) => {
        for (const event of events) this.absorbArtifact(event);
      })
      .catch(() => {});
    const results = await Promise.all([
      this.queryHistory([{ kinds: [K.MESSAGE], "#h": [channelId], limit: 200 }]),
      this.queryHistory([{ kinds: [K.REACTION], "#h": [channelId], limit: 300 }]),
      this.queryHistory([{ kinds: [K.DELETION], "#h": [channelId], limit: 300 }]),
      this.queryHistory([{ kinds: [K.MSG_EDIT, K.MSG_PIN, K.MSG_BOOKMARK], "#h": [channelId], limit: 300 }]),
      this.queryHistory([{ kinds: [K.PAYMENT_RECEIPT], "#h": [channelId], limit: 300 }]),
      threadRoot ? this.queryHistory([
        { kinds: [K.MESSAGE], "#h": [channelId], ids: [threadRoot], limit: 1 },
        { kinds: [K.MESSAGE], "#h": [channelId], "#e": [threadRoot], limit: 200 },
      ]) : Promise.resolve({ events: [], failures: [] }),
    ]);
    const [msgs, reactions, deletions, ops, receipts, thread] = results.map(result => result.events);
    const ordered = msgs
      .filter((e) => this.state.isMember(e.pubkey))
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-HISTORY_LIMIT);
    // A sparse thread jump must not move ordinary channel paging past its gap.
    if (ordered.length && !results[0].failures.length && !this.olderUntil.has(channelId)) {
      this.olderUntil.set(channelId, ordered[0].created_at);
    }
    for (const event of [...ordered, ...thread.filter(e => e.kind === K.MESSAGE && this.state.isMember(e.pubkey) && e.tags.some(t => t[0] === "h" && t[1] === channelId))]) {
      if (this.seenMessages.has(event.id)) continue;
      this.seenMessages.add(event.id);
      const msg = this.cacheMessage(channelId, event);
      this.emit("message", channelId, msg, { live: false, prepend: false });
    }
    if (threadRoot) this.messagesByChannel.get(channelId)?.sort((a, b) => a.ts - b.ts);
    for (const event of ops.filter((e) => e.kind === K.MSG_EDIT).sort((a, b) => a.created_at - b.created_at)) {
      this.handleMsgEdit(event);
    }
    for (const event of reactions.sort((a, b) => a.created_at - b.created_at)) this.handleReaction(event, false);
    for (const event of receipts.sort((a, b) => a.created_at - b.created_at)) this.handleReceipt(event);
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
    this.finishHistory(channelId, loading, results.flatMap(result => result.failures));
  }

  /** Scroll-up paging: until-filter keyset with limit+1 has_more probe. Returns the fresh page, oldest first. */
  async loadOlderPage(channelId: string): Promise<Msg[]> {
    // A failed initial read may leave only sparse thread rows in the cache.
    // Finish/retry the recent window before using its ordinary paging cursor.
    if (this.historyByChannel.has(channelId) && !this.olderUntil.has(channelId)) return [];
    const oldest = this.olderUntil.get(channelId) ?? this.messagesByChannel.get(channelId)?.[0]?.ts;
    if (!oldest || this.exhaustedChannels.has(channelId)) return [];
    // Partial rows may move the oldest message. Retry the original window
    // until it completes, or messages between those timestamps get skipped.
    this.olderUntil.set(channelId, oldest);
    const loading = this.beginHistory(channelId, "older");
    const { events, failures: queryFailures } = await this.queryHistory([
      { kinds: [K.MESSAGE], "#h": [channelId], until: oldest, limit: PAGE_SIZE + 1 },
    ]);
    const failures = [...queryFailures];
    // Page the newest limit+1 rows of the merged relay responses. An old
    // cached partial row, or a sparse mirror, must not skip a dense page.
    const page = [...events].sort((a, b) => b.created_at - a.created_at).slice(0, PAGE_SIZE + 1);
    if (!failures.length && page.length > PAGE_SIZE && page[page.length - 1].created_at >= oldest) {
      // ponytail: timestamp paging stops at a full tied-second window;
      // expand the query window if paging dense imports is needed.
      failures.push({ url: this.wire.relays?.[0] ?? "relay", reason: "History could not advance past messages with the same timestamp" });
    }
    if (!failures.length && this.olderUntil.get(channelId) === oldest) {
      if (page.length) this.olderUntil.set(channelId, page[page.length - 1].created_at);
      if (events.length <= PAGE_SIZE) this.exhaustedChannels.add(channelId);
    }
    const fresh = (failures.length ? events : page)
      .filter((e) => !this.seenMessages.has(e.id) && this.state.isMember(e.pubkey))
      .sort((a, b) => a.created_at - b.created_at);
    const freshMsgs: Msg[] = [];
    for (const event of fresh) {
      this.seenMessages.add(event.id);
      const msg = this.buildMsg(event);
      freshMsgs.push(msg);
      this.msgByIdMap.set(msg.id, msg);
      if (msg.rootId) this.threadNo(msg.rootId);
    }
    const list = this.messagesByChannel.get(channelId) ?? [];
    this.messagesByChannel.set(channelId, [...freshMsgs, ...list].sort((a, b) => a.ts - b.ts).slice(-MSG_CACHE_CAP));
    this.finishHistory(channelId, loading, failures);
    return freshMsgs;
  }

  // ── Startup ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.state.load();

    // Always-on, channel-orthogonal subscriptions.
    // Decrypting handlers may be async (custody seam) — one shared chain
    // keeps arrival order, so a slow decrypt can't reorder a feed.
    this.wire.subscribe([{ kinds: [K.OBSERVER], "#p": [this.pubkey] }], (e) => {
      this.cryptoIngest = this.cryptoIngest.then(() => this.handleObserverFrame(e)).catch(() => {});
    });
    this.wire.subscribe(
      [{ kinds: [K.GIFT_WRAP], "#p": [this.pubkey], since: this.sessionStartS - DM_FUZZ_WINDOW_S }],
      (e) => {
        this.cryptoIngest = this.cryptoIngest.then(() => this.handleGiftWrap(e)).catch(() => {});
      }
    );
    this.wire.subscribe([{ kinds: [K.PRESENCE] }], (e) => {
      this.lastSeenByPk.set(e.pubkey, Date.now());
    });
    // Reminders: pubkey-scoped, not channel-scoped, so they live outside
    // resubscribe()'s channel-set filters. New ones arm as they arrive;
    // an own-authored kind-5 e-tagging an armed id disarms it (the
    // reminder never fires — it does NOT get tombstoned by firing).
    this.wire.subscribe([{ kinds: [K.REMINDER, K.REMINDER_V2], authors: [this.pubkey] }], (e) => {
      void this.armReminder(e);
      // Fires for every write, including the ones that only change
      // status — an open pane should not need closing to become true.
      this.emit("remindersChanged");
    });
    this.wire.subscribe([{ kinds: [K.DELETION], authors: [this.pubkey] }], (e) => {
      for (const tag of e.tags) {
        if (tag[0] !== "e") continue;
        const timer = this.reminderTimers.get(tag[1]);
        if (timer) {
          clearTimeout(timer);
          this.reminderTimers.delete(tag[1]);
        }
      }
    });
    const beat = () => void this.wire.publish({ kind: K.PRESENCE, tags: [], content: "{}" }).catch(() => {});
    beat();
    setInterval(() => {
      beat();
      this.emit("presenceChanged");
    }, PRESENCE_BEAT_MS).unref?.();
    setInterval(() => this.emit("typingChanged"), 1000).unref?.();

    // Reminders hydrate: arm every own, non-tombstoned reminder already
    // on the relay so a stored one still fires after a restart if its
    // time hasn't passed yet.
    try {
      const [reminderEvents, ownDeletions] = await Promise.all([
        this.wire.query([{ kinds: [K.REMINDER, K.REMINDER_V2], authors: [this.pubkey] }]),
        this.wire.query([{ kinds: [K.DELETION], authors: [this.pubkey] }]),
      ]);
      const tombstoned = new Set<string>();
      for (const del of ownDeletions) {
        for (const tag of del.tags) if (tag[0] === "e" && tag[1]) tombstoned.add(tag[1]);
      }
      for (const event of reminderEvents) {
        if (tombstoned.has(event.id)) continue;
        // Staleness lives in armReminder itself (one arming path): a
        // long-past reminder stays silent whether it arrives here or as a
        // relay replay through the live subscription.
        void this.armReminder(event);
      }
    } catch { /* live stream fills in */ }

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
          const body = JSON.parse(await this.wire.decrypt(this.pubkey, event.content)) as { last_read?: unknown; muted?: unknown };
          if (d === K.MUTES_D) {
            this.mutedByMe = new Set(Array.isArray(body.muted) ? (body.muted as string[]) : []);
          } else {
            this.lastReadByChannel.set(d, Number(body.last_read) || 0);
          }
        } catch { /* not ours / old format */ }
      }
    } catch { /* badges start from zero */ }

    // The WIRE is the authority on where this client is. Restored state
    // remembers where you were last time; the wire says where you are
    // connected NOW — and when the two disagree (the user changed the
    // relay in settings and relaunched), following the stored one splits
    // the brain: sockets on the new relay, identity/NIP-11/owner from
    // the old. That exact split shipped once — the settings said the new
    // relay, the panel honestly described the old one, and nothing
    // looked wrong except everything. open() keeps the old workspace on
    // the rail, so this is a move, not a loss.
    // Guarded by membership, not equality: a multi-relay wire may have
    // its active workspace legitimately on the second relay of the set.
    // Split-brain is specifically a workspace the wire is not connected
    // to at all. Compared NORMALIZED (scheme-case, host-case, default
    // port, trailing slash): a stored invite string like
    // "wss://Relay.example/" byte-differing from the wire's
    // "wss://relay.example" force-moved the workspace every boot and
    // forked one relay into two rail entries (review finding F10).
    const normalizeRelay = (value: string): string => {
      try {
        const url = new URL(value.trim());
        return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
      } catch {
        return value.trim().toLowerCase().replace(/\/+$/, "");
      }
    };
    const wired = (this.wire.relays ?? []).map(normalizeRelay);
    if (wired[0] && !wired.includes(normalizeRelay(this.state.workspace.relay))) {
      this.state.open(this.wire.relays![0]);
    }

    // Who owns this workspace has to be known before any governed event
    // is absorbed — the state model rejects everything while unclaimed.
    const info = await this.wire.relayInfo?.(this.state.workspace.relay).catch(() => undefined);
    if (info) this.relayInfoDoc = info;
    this.state.describe({ name: info?.name, owner: info?.pubkey });

    await this.syncWorkspace();

    const inputSince = Math.floor((Date.now() - INPUT_WAIT_MS) / 1000);
    const inputFilters = [
      { kinds: [K.INPUT_REQUEST], "#p": [this.pubkey], since: inputSince },
      { kinds: [K.INPUT_RESPONSE], authors: [this.pubkey], since: inputSince },
    ];
    this.wire.subscribe(inputFilters, event => {
      this.cryptoIngest = this.cryptoIngest.then(() => event.kind === K.INPUT_RESPONSE ? this.handleInputResponse(event) : this.handleInputRequest(event)).catch(() => {});
    });
    for (const event of await this.wire.query(inputFilters).catch(() => [])) {
      if (event.kind === K.INPUT_RESPONSE) await this.handleInputResponse(event).catch(() => {});
      else await this.handleInputRequest(event).catch(() => {});
    }

    // Nothing is created on first run. There is no workspace event to
    // mint, so the duplicate-"Home" bug has no way to happen: an
    // unclaimed relay is offered to you to claim, and a claimed one you
    // are not on says so plainly rather than looking empty.
    if (!this.state.workspace.owner) {
      this.emit("notice", "🏗  This relay has no owner yet — it's an unclaimed workspace. Claim it to create the first channel.");
    } else if (!this.state.isMember(this.pubkey)) {
      this.emit(
        "notice",
        `🚪 You're connected to ${this.state.workspace.name} but not on its roster yet — ask the owner for an invite. Your key: ${this.pubkey.slice(0, 12)}…`
      );
    }

    this.resubscribe();

    // Docs hydrate.
    try {
      const docEvents = await this.wire.query([{ kinds: [K.DOC], "#h": this.channelIds(), limit: 500 }]);
      for (const event of docEvents) this.absorbDocEvent(event);
    } catch { /* live stream fills in */ }

    // Land somewhere: the channel you were last in, else the first one.
    if (!this.state.scope) {
      const first = [...this.state.workspace.channels.keys()][0];
      if (first) this.state.scope = { channelId: first };
    }
    const scope = this.state.scope;
    if (scope) await this.loadChannelHistory(scope.channelId);
    this.emit("channelsChanged");
  }

  // ── Internal machinery (ported 1:1 from the communities extension) ─────

  private buildMsg(event: WireEvent): Msg {
    const media = parseImeta(event.tags);
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
      mentionPks: event.tags.filter((t) => t[0] === "p").map((t) => t[1]),
      ...(media.length ? { media } : {}),
    };
  }

  private cacheMessage(channelId: string, event: WireEvent): Msg {
    // Idempotent by event id: the sender's own optimistic cache races the
    // relay's echo of the same event through the live subscription (the
    // echo can land before publish() resolves, before seenMessages is
    // marked), and both paths land here. Without this, one message
    // rendered twice — identical reactions on each copy, since both rows
    // shared the id.
    const already = this.msgByIdMap.get(event.id);
    if (already) return already;
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

  /** Backfill a DM channel's metadata — edits before deletions, same order as loadChannelHistory. */
  private async loadDmMeta(channelId: string): Promise<void> {
    const events = await this.wire.query([
      { kinds: [K.REACTION, K.DELETION, K.MSG_EDIT], "#h": [channelId], limit: 300 },
    ]);
    const sorted = events.sort((a, b) => a.created_at - b.created_at);
    for (const event of sorted) if (event.kind === K.MSG_EDIT) this.handleMsgEdit(event);
    for (const event of sorted) if (event.kind === K.REACTION) this.handleReaction(event, false);
    for (const event of sorted) if (event.kind === K.DELETION) this.handleDeletion(event);
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
      const meta = JSON.parse(event.content) as { name?: string; about?: string; skills?: unknown; repo?: unknown; branch?: unknown; aliases?: unknown };
      if (meta.name && this.names.get(event.pubkey) !== meta.name) {
        this.names.set(event.pubkey, meta.name);
        if (emitChange) this.emit("presenceChanged");
      }
      if (meta.name) {
        this.agentMeta.set(event.pubkey, {
          about: typeof meta.about === "string" ? meta.about : undefined,
          skills: Array.isArray(meta.skills) ? meta.skills.filter((s): s is string => typeof s === "string") : undefined,
          // The zsh-prompt fields: what the agent's checkout is actually
          // on, announced at spawn — capped like channel meta, these
          // reach a header.
          repo: typeof meta.repo === "string" ? meta.repo.slice(0, 100) : undefined,
          branch: typeof meta.branch === "string" ? meta.branch.slice(0, 100) : undefined,
          // Capped like skills: an announcement is self-asserted wire input.
          aliases: Array.isArray(meta.aliases)
            ? meta.aliases.filter((a): a is string => typeof a === "string").slice(0, 8).map((a) => a.slice(0, 64))
            : undefined,
        });
      }
    } catch { /* ignore */ }
  }

  private channelIds(): string[] {
    return [...this.state.workspace.channels.keys()];
  }

  private dmChannelIds(): string[] {
    return [...this.dmConvos.keys()].map((key) => this.dmChannelId(key));
  }

  /**
   * Pull the workspace's state from the relay.
   *
   * The roster is a signed event on the relay, and local state is a
   * CACHE of it — treating the cache as the record is how the previous
   * model lost people: clear storage, move machine, reinstall, and the
   * client concluded you belonged nowhere, then helpfully made you a
   * brand-new empty "Home". Three of those on one relay is what that
   * looks like after it happens a few times.
   *
   * Flat removes the whole failure: there is nothing to recover, because
   * the workspace is the relay you are pointed at and its roster is
   * fetched fresh right here. Being on it is decided by the owner's
   * latest 47102, so a removal is honoured the moment it lands.
   */
  private async syncWorkspace(): Promise<void> {
    if (!this.state.workspace.relay) return;
    const events = await this.wire.query([
      { kinds: [K.CHANNEL], limit: 500 },
      { kinds: [K.MEMBERSHIP], "#d": [K.ROSTER_D], limit: 100 },
      { kinds: [K.BAN_LIST], "#d": [K.BANS_D], limit: 100 },
    ]);
    // Channels first: absorb() resolves roster ordering independently,
    // but a channel has to exist before the sidebar can show it.
    for (const kind of [K.CHANNEL, K.MEMBERSHIP, K.BAN_LIST]) {
      for (const event of events.filter((e) => e.kind === kind)) this.state.absorb(event);
    }

    this.emit("channelsChanged");
  }

  private resubscribe(): void {
    this.unsubscribeLive?.();
    const channelIds = this.channelIds();
    // DM channels ride the same #h pipe for their metadata (reactions,
    // edits, unsends) — the ids are derived, never published, so they
    // join here rather than in channelIds() (which feeds the channel UI).
    const dmIds = this.dmChannelIds();
    this.subscribedChannelIds = [...channelIds, ...dmIds].sort().join(",");
    // Workspace state is unscoped now — one relay, one workspace, so
    // every channel and the single roster are simply "what is here".
    const filters: WireFilter[] = [
      { kinds: [K.AGENT_METADATA], since: Math.floor(Date.now() / 1000) - 7 * 86400 },
      { kinds: [K.CHANNEL] },
      { kinds: [K.MEMBERSHIP], "#d": [K.ROSTER_D] },
      { kinds: [K.BAN_LIST], "#d": [K.BANS_D, K.REMOVED_D] },
    ];
    if (channelIds.length > 0) {
      filters.push(
        {
          kinds: [K.MESSAGE, K.TYPING, K.REACTION, K.DELETION, K.DRAFT, K.WORKFLOW_RUN, K.DOC, K.DOC_COMMENT, K.MSG_EDIT, K.MSG_PIN, K.MSG_BOOKMARK, K.ARTIFACT, K.PAYMENT_RECEIPT],
          "#h": channelIds,
          since: Math.floor(Date.now() / 1000),
        },
        { kinds: [K.THREAD_SUMMARY], "#h": channelIds }
      );
    }
    if (dmIds.length > 0) {
      filters.push({
        kinds: [K.REACTION, K.DELETION, K.MSG_EDIT],
        "#h": dmIds,
        since: Math.floor(Date.now() / 1000),
      });
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
      case K.DOC_COMMENT: return this.handleDocComment(event);
      case K.ARTIFACT: return this.absorbArtifact(event);
      case K.PAYMENT_RECEIPT: return this.handleReceipt(event);
      case K.AGENT_METADATA: return this.absorbName(event);
      case K.MESSAGE: return this.handleIncomingMessage(event);
      default: {
        this.state.absorb(event);
        if (event.kind === K.CHANNEL) {
          const ids = [...this.channelIds(), ...this.dmChannelIds()].sort().join(",");
          // Resubscribe ONLY when the channel set changed — replayed
          // 47101s once fed a resubscribe feedback loop pinning the TUI
          // at 98% CPU.
          if (ids !== this.subscribedChannelIds) this.resubscribe();
        }
        if (event.kind === K.BAN_LIST) this.applyRemovals();
        this.emit("channelsChanged");
      }
    }
  }

  private handleIncomingMessage(event: WireEvent): void {
    if (this.seenMessages.has(event.id)) return;
    for (const key of this.typing.keys()) if (key.startsWith(`${event.pubkey}:`)) this.typing.delete(key);
    this.emit("typingChanged");
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) return;
    if (!this.state.isMember(event.pubkey)) return;

    // Seen means ACCEPTED, and only accepted. Marking before the
    // membership gate made rejection permanent for the session: a
    // message from a not-yet-rostered author (the @fez opener, posted a
    // beat before its key landed on the roster) could never render
    // until a full restart, however many times history replayed it.
    this.seenMessages.add(event.id);

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
    if (!targetId || !channelId) return;
    if (!this.state.isMember(event.pubkey)) return;
    const emoji = event.content.trim();
    if (!emoji || emoji.length > 8) return;
    let byEmoji = this.reactionsByTarget.get(targetId);
    if (!byEmoji) this.reactionsByTarget.set(targetId, (byEmoji = new Map()));
    let who = byEmoji.get(emoji);
    if (!who) byEmoji.set(emoji, (who = new Set()));
    who.add(this.displayName(event.pubkey));
    this.reactionIndex.set(event.id, { targetId, emoji, authorPk: event.pubkey, ts: event.created_at });
    this.emit("reaction", channelId, targetId);

    // Status reactions open jobs (👀 accepted / 💬 working) — live only:
    // a stored 👀 from last week is history, not an active turn. DM
    // reactions are just reactions — no job machinery in a conversation.
    if (live && !channelId.startsWith("dm:") && (emoji === "👀" || emoji === "💬")) {
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
      if (!msg) {
        // DM unsend: author-only (a DM has no moderator), honest
        // tombstone — the rumor was already delivered; honoring clients
        // blank it, nothing is recalled.
        const dm = this.dmMsgById(tag[1]);
        if (dm && !dm.msg.deletedBy && event.pubkey === dm.msg.senderPk) {
          dm.msg.deletedBy = "author";
          dm.msg.text = "";
          this.emit("metaChanged", dm.channelId, tag[1]);
        }
        continue;
      }
      if (msg.deletedBy) continue;
      const channelId =
        event.tags.find((t) => t[0] === "h")?.[1] ?? this.channelOfMessage(tag[1]);
      if (!channelId) continue;
      const isAuthor = event.pubkey === msg.authorPk;
      // The workspace owner is the moderation authority — the same key
      // that signs the roster, which is what makes the tombstone
      // trustworthy rather than a stranger's kind 5.
      const isModerator = this.state.canModerate(event.pubkey);
      if (!isAuthor && !isModerator) continue;
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
    if (!target) {
      // DM edit: same author-only + latest-wins rules, applied to the
      // rumor in conversation state instead of a channel message.
      const dm = this.dmMsgById(targetId);
      if (!dm || event.pubkey !== dm.msg.senderPk || dm.msg.deletedBy) return;
      if (event.created_at < (dm.msg.editTs ?? 0)) return;
      dm.msg.text = event.content;
      dm.msg.edited = true;
      dm.msg.editTs = event.created_at;
      this.emit("metaChanged", dm.channelId, targetId);
      return;
    }
    if (event.pubkey !== target.authorPk) return; // author-only
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
    if (!targetId || !channelId) return;
    if (!this.state.isMember(event.pubkey)) return;
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
    if (!rootId || !channelId) return;
    if (!this.state.isMember(event.pubkey)) return;
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
    if (!channelId || !event.content) return;
    if (event.pubkey === this.pubkey) return;
    if (!this.state.isMember(event.pubkey)) return;
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
    if (!channelId) return;
    if (!this.state.isMember(event.pubkey)) return;
    let body: { type?: string; title?: string; url?: string; content?: string };
    try {
      body = JSON.parse(event.content);
    } catch {
      return;
    }
    if (!body.type || typeof body.type !== "string") return;
    this.seenArtifactIds.add(event.id);
    const rootId = event.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1];
    const artifact: Artifact = {
      id: event.id,
      channelId,
      authorPk: event.pubkey,
      authorName: this.displayName(event.pubkey),
      type: body.type.slice(0, 32),
      title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
      content: typeof body.content === "string" ? body.content : undefined,
      ts: event.created_at,
      rootId,
    };
    const list = this.artifactsByChannel.get(channelId) ?? [];
    list.push(artifact);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > 100) list.splice(0, list.length - 100);
    this.artifactsByChannel.set(channelId, list);
    this.emit("artifact", channelId, artifact);
  }

  /** A payment receipt (47040) — same shape rule as handleReaction:
   * needs both the message it pays for (`e`) and the channel it was
   * published into (`h`), and the author must be a workspace member.
   * Verifying the receipt against the chain is NOT this client's job —
   * it stores the signed event verbatim for a caller (fez-wallet's gui
   * part) to parse and check on its own terms. */
  private handleReceipt(event: WireEvent): void {
    if (this.seenReceiptIds.has(event.id)) return;
    const targetId = event.tags.find((t) => t[0] === "e")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!targetId || !channelId) return;
    if (!this.state.isMember(event.pubkey)) return;
    this.seenReceiptIds.add(event.id);
    const list = this.receiptsByTarget.get(targetId) ?? [];
    list.push(event);
    this.receiptsByTarget.set(targetId, list);
    this.emit("paymentReceipt", channelId, targetId);
  }

  private async handleObserverFrame(event: WireEvent): Promise<void> {
    const agent = event.tags.find((t) => t[0] === "agent")?.[1];
    if (!agent) return;
    let frame: ObserverEntry;
    try {
      frame = JSON.parse(await this.wire.decrypt(event.pubkey, event.content));
    } catch {
      return; // not for us — ignorable by design
    }
    const feed = this.observerFeedsMap.get(agent) ?? [];
    feed.push(frame);
    if (feed.length > 30) feed.splice(0, feed.length - 30);
    this.observerFeedsMap.set(agent, feed);

    // `root` is sticky for the turn: only the turn-started frame carries
    // it, later tool frames must not clobber it back to top-level.
    const frameRoot = (frame as { root?: string }).root;
    const heldRoot = this.workingAgentsMap.get(agent)?.root;
    if (frame.type === "turn" && frame.status !== "started") this.workingAgentsMap.delete(agent);
    else if (frame.type === "tool" && frame.title) this.workingAgentsMap.set(agent, { activity: frame.title, ts: Date.now(), root: heldRoot });
    else if (frame.type === "turn") this.workingAgentsMap.set(agent, { activity: "working…", ts: Date.now(), root: frameRoot });

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

  private async handleGiftWrap(event: WireEvent): Promise<void> {
    const dm = await this.wire.unwrapDm(event);
    if (!dm || this.seenDmIds.has(dm.id)) return;
    this.seenDmIds.add(dm.id);
    // Conversation = the participant SET, so every member of a group DM
    // derives the same thread. 1:1 keys stay the bare peer pubkey.
    const participants = dm.participants ?? [dm.senderPk, dm.peerPk];
    const key = dmConvoKey(participants, this.pubkey) || dm.peerPk;
    const isNewConvo = !this.dmConvos.has(key);
    const convo = this.dmConvo(key);
    if (isNewConvo) {
      // A conversation exists now, so its metadata channel does too:
      // widen the live subscription and pull any reactions/edits/unsends
      // that landed while we weren't listening. Fire-and-forget — DM
      // delivery never waits on metadata.
      this.resubscribe();
      // ponytail: fixed 1.5s delay so the cold-start wrap replay finishes
      // unwrapping this convo's messages before edits/unsends look them
      // up; a settle-detector on the replay if the window ever grows.
      setTimeout(() => void this.loadDmMeta(this.dmChannelId(key)).catch(() => {}), 1500);
    }
    convo.participants = participants;
    convo.msgs.push({ id: dm.id, senderPk: dm.senderPk, text: dm.text, ts: dm.ts });
    convo.msgs.sort((a, b) => a.ts - b.ts);
    if (convo.msgs.length > 100) convo.msgs.splice(0, convo.msgs.length - 100);
    const live = dm.ts >= this.sessionStartS;
    if (live && dm.senderPk !== this.pubkey) convo.unread++;
    this.emit("dmMessage", { id: dm.id, senderPk: dm.senderPk, text: dm.text, ts: dm.ts, peerPk: key }, { live });
  }

  private absorbDocEvent(event: WireEvent): string | undefined {
    if (this.docEvents.has(event.id)) return undefined;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) return undefined;
    // A d tag makes it a named wiki page, not the channel's doc — pages
    // are gated community-wide, channel docs by their channel.
    const slug = event.tags.find((t) => t[0] === "d")?.[1];
    const allowed = slug
      ? this.state.isMember(event.pubkey)
      : this.state.isMember(event.pubkey); // workspace-wide either way
    if (!allowed) return undefined;
    this.docEvents.set(event.id, event);
    // ponytail: scan cached versions on arrival; index by document if large histories make this costly.
    const latest = orderVersions([...this.docEvents.values()].filter(version => slug
      ? version.tags.some(t => t[0] === "d" && t[1] === slug)
      : !version.tags.some(t => t[0] === "d") && version.tags.some(t => t[0] === "h" && t[1] === channelId)
    ).filter(version => this.state.isMember(version.pubkey))).at(-1)!;
    if (slug) {
      // Wiki pages are workspace-scoped, and the workspace is the relay
      // — the slug alone addresses a page now.
      const key = slug;
      let page = this.wikiMap.get(key)!;
      if (!page) {
        this.wikiMap.set(key, (page = { slug, title: slug, channelId, count: 0, latestId: "", latestTs: 0, latestAuthor: "", latestContent: "" }));
      }
      page.count++;
      if (page.latestId !== latest.id) {
        page.latestTs = latest.created_at;
        page.latestId = latest.id;
        page.latestAuthor = latest.pubkey;
        page.latestContent = latest.content;
        page.channelId = latest.tags.find(t => t[0] === "h")?.[1] ?? channelId;
        // Title precedence: the explicit tag, else the page's own first
        // heading, else the slug. Agents writing via fez_wiki_write don't
        // always set the tag, and "open-questions" is a worse label than
        // the "# Open Questions" sitting in the content.
        // Title precedence: an INFORMATIVE tag, else the page's own first
        // heading, else the slug. A tag that merely repeats the slug
        // ("open-questions") carries nothing — agents pass the slug as
        // the page name when that's how they were asked for it — so the
        // heading in the content wins over it.
        const tagged = latest.tags.find((t) => t[0] === "title")?.[1]?.trim();
        const heading = /^#{1,6}\s+(.+)$/m.exec(latest.content)?.[1]?.trim();
        page.title = (tagged && tagged !== slug ? tagged : undefined) ?? heading ?? tagged ?? slug;
      }
      return channelId;
    }
    let info = this.docsByChannelMap.get(channelId);
    if (!info) this.docsByChannelMap.set(channelId, (info = { count: 0, latestId: "", latestTs: 0, latestAuthor: "", latestContent: "" }));
    info.count++;
    if (info.latestId !== latest.id) {
      info.latestTs = latest.created_at;
      info.latestId = latest.id;
      info.latestAuthor = latest.pubkey;
      info.latestContent = latest.content;
    }
    return channelId;
  }

  private handleDocEvent(event: WireEvent): void {
    const channelId = this.absorbDocEvent(event);
    if (channelId) this.emit("docChanged", channelId);
  }
}
