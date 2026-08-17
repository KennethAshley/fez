import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommunityState, type Role } from "./state.js";
import type { FezExtensionAPI, MessageHandle, NostrEvent, NostrFilter } from "./api-types.js";

const KIND_GIFT_WRAP = 1059; // NIP-59 gift wrap carrying a NIP-17 private DM — see fez src/dm.ts
const DM_FUZZ_WINDOW_S = 2 * 86_400; // wrap timestamps are fuzzed up to 2 days BACK — subscriptions must reach this far

const KIND_AGENT_METADATA = 47000;
const KIND_COMMUNITY = 47100;
const KIND_CHANNEL = 47101;
const KIND_MEMBERSHIP = 47102;
const KIND_CHANNEL_MESSAGE = 47103;
const KIND_TYPING = 20002; // ephemeral, Buzz's kind — see fez src/kinds.ts
const KIND_THREAD_SUMMARY = 39005; // indexer-published thread stats — see fez src/kinds.ts
const KIND_REACTION = 7; // standard nostr, Buzz's shape: content = emoji, ["e", target], plus ["h", channel] for subscription
const KIND_DELETION = 5; // standard nostr: retract your own events (agents clear status reactions)
const KIND_DRAFT = 20003; // ephemeral streaming preview of a message being composed — see fez src/kinds.ts
const KIND_OBSERVER = 20004; // ephemeral owner-encrypted agent activity frames — see fez src/kinds.ts
const KIND_WORKFLOW_RUN = 47200; // workflow run traces — see fez src/kinds.ts
const KIND_AGENT_ENGRAM = 30174; // NIP-AE agent memory — see fez src/engram.ts
// Channel doc — Buzz's canvas (kind 40100): ONE living markdown document
// per channel, editable by any member, humans and agents alike. Regular
// (non-replaceable) kind on a dumb relay means every version is stored —
// /doc history is free. Latest member-authored version wins client-side
// (created_at desc, tie → lowest id), same trust rules as messages.
const KIND_DOC = 40100;
// Stream-message operations (Buzz's 4000x family) — all client-side
// trust like everything else: an edit counts only from the original
// author; pins/bookmarks count from members; kind 5 by the op's author
// retracts it.
const KIND_MSG_EDIT = 40003;     // ["e", target] — content = replacement text
const KIND_MSG_PIN = 40004;      // ["e", target], ["h"], ["c"] — channel pin
const KIND_MSG_BOOKMARK = 40005; // ["e", target] — personal bookmark (only your own render)

/** How long a typing indicator survives without a fresh heartbeat (Buzz: 8s TTL on a 3s publish interval). */
const TYPING_TTL_MS = 8000;

/**
 * Fez communities — Buzz-shaped channels over fez-native nostr kinds
 * (see src/kinds.ts in fez for the 471xx schema and client-side trust
 * rules). Installed as a single bundled file; everything it touches comes
 * off the FezExtensionAPI object — no runtime imports beyond node builtins.
 *
 * /community create <name> | list | join <id>
 * /channels | /join <channel> | /leave | /members | /invite <pubkey> [role]
 *
 * While a channel scope is active, plain chat input publishes into the
 * channel (mentions resolved against channel members); incoming channel
 * messages from other members render as chat bubbles. Standing agents
 * (channel-agent.ts, run separately via `fez run`) answer mentions over
 * the relay.
 */
export default function communities(api: FezExtensionAPI): void {
  const nostr = api.nostr;
  if (!nostr) return; // CLI subcommand context — nothing chat-shaped to do

  const state = new CommunityState();
  state.load();
  const names = new Map<string, string>(); // pubkey -> display name (from 47000)
  const seenMessages = new Set<string>();
  let unsubscribe: (() => void) | undefined;

  // ── Message cache + threads (client-side; Buzz keeps thread_metadata
  // server-side, fez derives it from NIP-10 markers on the fly) ───────────
  interface Msg {
    id: string;
    authorPk: string;
    authorName: string;
    content: string;
    parentId?: string;
    rootId?: string; // set iff the message is part of a thread
    ts: number;
    /** Set when a 40003 edit has replaced the content. */
    edited?: boolean;
    editTs?: number;
  }
  const MSG_CACHE_CAP = 1000; // sized for scroll-up paging — pages accumulate until eviction
  const messagesByChannel = new Map<string, Msg[]>();
  const msgById = new Map<string, Msg>();
  // Threads get small user-facing numbers (#1, #2, …) as they're first seen —
  // event-id hex is unusable as a command argument.
  const threadNoByRoot = new Map<string, number>();
  const rootByThreadNo = new Map<number, string>();
  let nextThreadNo = 1;

  let view:
    | { mode: "channel" }
    | { mode: "thread"; rootId: string }
    | { mode: "watch"; agent: string }
    | { mode: "jobs" }
    | { mode: "dm"; peerPk: string }
    | { mode: "doc" } = { mode: "channel" };

  // ── Jobs: units of agent work, ASSEMBLED from events already on the
  // wire — nothing publishes "a job". A mention an agent accepts (its 👀
  // status reaction) opens one; 💬 marks it working; the threaded reply
  // closes it; owner-only observer frames enrich it with the current tool
  // and catch failed/steered turns. Because it's all derived, the board
  // covers agents running anywhere — herdr-supervised, manual, or on
  // another machine. herdr itself stays what it's good at: supervision.
  interface Job {
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
  const jobs = new Map<string, Job>(); // `${agentPk}:${triggerId}`
  const JOB_CAP = 100;
  function trimJobs(): void {
    while (jobs.size > JOB_CAP) {
      const oldest = jobs.keys().next().value as string;
      jobs.delete(oldest);
    }
  }
  function activeJobs(): Job[] {
    return [...jobs.values()].filter((j) => j.status === "seen" || j.status === "working");
  }
  /** An agent's most recent unfinished job — where observer enrichment lands. */
  function latestOpenJob(agentPk: string): Job | undefined {
    let found: Job | undefined;
    for (const job of jobs.values()) {
      if (job.agentPk === agentPk && (job.status === "seen" || job.status === "working")) found = job;
    }
    return found;
  }
  function jobsChanged(): void {
    if (view.mode === "jobs") renderJobsView();
    refreshUi(); // sidebar job count
  }

  // Workflow runs (47200) — the automations' own job trail. Latest trace
  // per run wins; capped like jobs.
  const workflowRuns = new Map<string, { workflow: string; status: string; step?: number; ts: number }>();
  function handleWorkflowRun(event: NostrEvent): void {
    try {
      const trace = JSON.parse(event.content) as { workflow?: string; run?: string; status?: string; step?: number };
      if (!trace.workflow || !trace.run || !trace.status) return;
      workflowRuns.set(trace.run, { workflow: trace.workflow, status: trace.status, step: trace.step, ts: event.created_at * 1000 });
      while (workflowRuns.size > 50) workflowRuns.delete(workflowRuns.keys().next().value as string);
      if (view.mode === "jobs") renderJobsView();
    } catch {
      /* not a trace we understand */
    }
  }

  // ── Observer stream (owner-only, NIP-44) — live window into owned
  // agents. Frames decrypt with the user's key; per-agent rolling
  // activity feeds the /watch view and a glanceable footer segment. ─────
  interface ObserverEntry {
    type: string;
    text?: string;
    title?: string;
    status?: string;
    ts: number;
  }
  const observerFeeds = new Map<string, ObserverEntry[]>(); // agent name -> rolling entries
  let watchThoughtBubble: MessageHandle | undefined;
  let watchTextBubble: MessageHandle | undefined;

  const workingAgents = new Map<string, { activity: string; ts: number }>();
  function renderObserverStatus(): void {
    const now = Date.now();
    for (const [name, w] of workingAgents) if (now - w.ts > 180_000) workingAgents.delete(name);
    const parts = [...workingAgents.entries()].map(([name, w]) => `${name}: ${w.activity}`);
    api.ui.setStatus("observer", parts.length === 0 ? "" : `⚙ ${parts.slice(0, 3).join(" · ")}`);
  }
  setInterval(renderObserverStatus, 5000).unref?.();

  function handleObserverFrame(event: NostrEvent): void {
    const agent = event.tags.find((t) => t[0] === "agent")?.[1];
    if (!agent) return;
    let frame: ObserverEntry;
    try {
      frame = JSON.parse(nostr!.decrypt(event.pubkey, event.content));
    } catch {
      return; // not for us / garbage — ignorable by design
    }
    const feed = observerFeeds.get(agent) ?? [];
    feed.push(frame);
    if (feed.length > 30) feed.splice(0, feed.length - 30);
    observerFeeds.set(agent, feed);

    // Glanceable footer segment while owned agents are mid-turn —
    // aggregated across agents (single-slot overwrite flickered when two
    // agents worked at once). Stale entries expire in case a turn-done
    // frame is lost.
    if (frame.type === "turn" && frame.status !== "started") {
      workingAgents.delete(agent);
    } else if (frame.type === "tool" && frame.title) {
      workingAgents.set(agent, { activity: frame.title, ts: Date.now() });
    } else if (frame.type === "turn") {
      workingAgents.set(agent, { activity: "working…", ts: Date.now() });
    }
    renderObserverStatus();

    // Jobs enrichment (owner-only detail the public wire can't provide):
    // tool frames name what the open job is doing right now; failed and
    // steered turns close/flag it — the reply-based close never comes.
    for (const [pk, n] of names) {
      if (n !== agent) continue;
      const job = latestOpenJob(pk);
      if (!job) break;
      if (frame.type === "tool" && frame.title) {
        job.currentTool = frame.title;
        jobsChanged();
      } else if (frame.type === "turn" && frame.status === "failed") {
        job.status = "failed";
        job.endedAt = Date.now();
        job.currentTool = undefined;
        jobsChanged();
      } else if (frame.type === "turn" && frame.status === "steered") {
        job.status = "steered"; // the re-dispatched turn's 💬 reopens it
        job.currentTool = undefined;
        jobsChanged();
      }
      break;
    }

    // Automatic inline visibility: if this agent's draft bubble is on
    // screen (its reply streaming), its tool activity rides that bubble's
    // footer — no /watch needed for the common case. The final message
    // replaces the footer with reactions on adoption.
    if (frame.type === "tool" && frame.title) {
      for (const [pubkey, name] of names) {
        if (name === agent) {
          draftBubbles.get(pubkey)?.handle.setFooter(`⚙ ${frame.title}`);
          break;
        }
      }
    }

    // Live rendering inside /watch.
    if (view.mode !== "watch" || view.agent !== agent) return;
    if (frame.type === "thought" && frame.text) {
      if (!watchThoughtBubble) watchThoughtBubble = api.ui.appendMessage(`${agent} · thinking`, "");
      watchThoughtBubble.setContent(frame.text);
    } else if (frame.type === "text" && frame.text) {
      if (!watchTextBubble) watchTextBubble = api.ui.appendMessage(`${agent} · drafting`, "");
      watchTextBubble.setContent(frame.text);
    } else if (frame.type === "tool") {
      api.ui.appendMessage("⚙", `${frame.title ?? "tool"}${frame.status ? ` — ${frame.status}` : ""}`);
    } else if (frame.type === "turn") {
      api.ui.notify(`— turn ${frame.status} —`);
      // Next turn gets fresh bubbles.
      watchThoughtBubble = undefined;
      watchTextBubble = undefined;
    }
  }

  // Live-updatable UI state: handles to rendered bubbles (by message id)
  // so reactions land on them after the fact, and to thread-summary lines
  // (by root id) so counts update in place instead of appending repeats.
  // Both reset on every clearLog repaint — handles die with their bubbles.
  let bubbleHandles = new Map<string, MessageHandle>();
  let summaryLineHandles = new Map<string, MessageHandle>();

  // Reactions (kind 7): message id -> emoji -> reactor names. Rendered as
  // a dim footer row on the target's bubble. reactionIndex remembers each
  // reaction event so a kind-5 deletion (agents clear their 👀/💬 status
  // reactions when a turn ends — Buzz's lifecycle) can undo it.
  const reactionsByTarget = new Map<string, Map<string, Set<string>>>();
  const reactionIndex = new Map<string, { targetId: string; emoji: string; authorPk: string }>();

  function reactionFooter(targetId: string): string {
    const reactions = reactionsByTarget.get(targetId);
    if (!reactions || reactions.size === 0) return "";
    return [...reactions.entries()]
      .map(([emoji, who]) => `${emoji} ${[...who].join(", ")}`)
      .join("   ");
  }

  // Indexer-published thread stats (39005). Trust rule: only summaries
  // authored by a channel member count; latest created_at wins per root.
  // Display uses max(local count, summary count) — the indexer fills gaps
  // for clients that missed messages, local knowledge never regresses.
  const summaryByRoot = new Map<string, { replyCount: number; lastAuthorTs: number; summaryTs: number }>();

  function threadReplyCount(channelId: string, rootId: string): number {
    const local = threadReplies(channelId, rootId).length;
    return Math.max(local, summaryByRoot.get(rootId)?.replyCount ?? 0);
  }

  function handleThreadSummary(event: NostrEvent): void {
    const rootId = event.tags.find((t) => t[0] === "d")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!rootId || !channelId || !communityId) return;
    if (!state.isMember(communityId, channelId, event.pubkey)) return; // trust rule
    const existing = summaryByRoot.get(rootId);
    if (existing && event.created_at < existing.summaryTs) return;
    try {
      const { replyCount, lastReplyAt } = JSON.parse(event.content);
      if (typeof replyCount !== "number") return;
      summaryByRoot.set(rootId, { replyCount, lastAuthorTs: lastReplyAt ?? 0, summaryTs: event.created_at });
      threadNo(rootId); // late joiners learn the thread exists at all
      // Bump the live summary line if it's on screen (channel view only).
      if (view.mode === "channel" && summaryLineHandles.has(rootId)) {
        updateOrAppendSummaryLine(channelId, rootId);
      }
    } catch {
      /* malformed summary — ignore */
    }
  }

  /** Buzz's parse (threading.ts): parent = last reply-marked e-tag; root = root-marked ?? parent. */
  function parseThreadRef(tags: string[][]): { parentId?: string; rootId?: string } {
    const parentId = tags.filter((t) => t[0] === "e" && t[3] === "reply").at(-1)?.[1];
    const rootId = tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? parentId;
    return { parentId, rootId };
  }

  function threadNo(rootId: string): number {
    let no = threadNoByRoot.get(rootId);
    if (no === undefined) {
      no = nextThreadNo++;
      threadNoByRoot.set(rootId, no);
      rootByThreadNo.set(no, rootId);
    }
    return no;
  }

  function cacheMessage(channelId: string, event: NostrEvent, authorName: string): Msg {
    const { parentId, rootId } = parseThreadRef(event.tags);
    const msg: Msg = {
      id: event.id,
      authorPk: event.pubkey,
      authorName,
      content: event.content,
      parentId,
      rootId,
      ts: event.created_at,
    };
    const list = messagesByChannel.get(channelId) ?? [];
    list.push(msg);
    if (list.length > MSG_CACHE_CAP) list.splice(0, list.length - MSG_CACHE_CAP);
    messagesByChannel.set(channelId, list);
    msgById.set(msg.id, msg);
    if (rootId) threadNo(rootId);
    return msg;
  }

  function threadReplies(channelId: string, rootId: string): Msg[] {
    return (messagesByChannel.get(channelId) ?? []).filter((m) => m.rootId === rootId);
  }

  function snippet(text: string, max = 40): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  }

  // Typing indicators, keyed `${pubkey}:${threadRoot ?? "channel"}` — Buzz
  // keys by pubkey:threadHead so channel and thread typing stay separate.
  // The footer shows only indicators matching the CURRENT view. Pruned on
  // a 1s tick (TTL from last heartbeat), cleared instantly when that
  // author's real message lands.
  const typing = new Map<string, { pubkey: string; threadRoot?: string; expiry: number }>();
  function renderTyping(): void {
    const now = Date.now();
    for (const [key, t] of typing) if (t.expiry <= now) typing.delete(key);
    const currentRoot = view.mode === "thread" ? view.rootId : undefined;
    const who = [...typing.values()]
      .filter((t) => t.threadRoot === currentRoot)
      .map((t) => displayName(t.pubkey));
    api.ui.setStatus(
      "typing",
      who.length === 0 ? "" : who.length === 1 ? `${who[0]} is typing…` : `${who.slice(0, 3).join(", ")} are typing…`
    );
  }
  setInterval(renderTyping, 1000).unref?.();

  const panel = api.ui.createSidePanel({ width: 30, title: "channels", icon: "🗨️" });
  // order 30: below the herdr AGENTS box (extensions load after us and
  // take insertion order ~2) — DMs are conversations WITH those agents,
  // so they read as a sub-concern of the fleet, per the user's layout.
  const dmPanel = api.ui.createSidePanel({ title: "dms", icon: "✉️", order: 30 });
  // order 20: docs sit between AGENTS and DMS.
  const docsPanel = api.ui.createSidePanel({ title: "docs", icon: "📄", order: 20 });

  function displayName(pubkey: string): string {
    return names.get(pubkey) ?? `${pubkey.slice(0, 8)}…`;
  }

  function refreshUi(): void {
    // Live agent status under the tree: one line per busy agent (👀
    // accepted, ⚙ turn running, with the current tool when the observer
    // stream names one) — the glanceable answer to "what is reviewer
    // doing right now", no /watch needed.
    const busy = new Map<string, Job>();
    for (const job of activeJobs()) busy.set(job.agentPk, job);
    const statusLines = [...busy.values()]
      .slice(0, 5)
      .map((j) => ` ${j.status === "working" ? "⚙" : "👀"} @${displayName(j.agentPk)}${j.currentTool ? ` · ${j.currentTool}` : ""}`);
    panel.setText(
      state.sidebarText() + (statusLines.length > 0 ? `\n\n Working\n${statusLines.join("\n")}\n — /jobs` : "")
    );
    const current = state.currentChannel();
    if (view.mode === "dm") {
      api.ui.setStatus("scope", `✉ @${displayName(view.peerPk)} · private`);
      return;
    }
    const threadSuffix =
      view.mode === "thread"
        ? ` ▸ thread #${threadNo(view.rootId)}`
        : view.mode === "watch"
          ? ` ▸ watching @${view.agent}`
          : view.mode === "jobs"
            ? " ▸ jobs"
            : view.mode === "doc"
              ? " ▸ doc"
              : "";
    api.ui.setStatus(
      "scope",
      current ? `${current.community.name}/#${current.channel.name}${threadSuffix}` : ""
    );
  }

  /**
   * Bubble for a thread reply — flat, Slack's thread-panel model: the
   * thread view IS the scope, so replies render like normal messages in
   * arrival order (per-depth indentation tried and rejected — the view
   * provides the context, the margin doesn't need to).
   */
  function threadBubble(msg: Msg): MessageHandle {
    const handle = api.ui.appendMessage(msg.authorName, msg.content, msg.ts);
    handle.setFooter(reactionFooter(msg.id));
    return handle;
  }

  /** Register a freshly painted bubble so late reactions land on it. */
  function paintBubble(msg: Msg): void {
    const handle = api.ui.appendMessage(msg.authorName, msg.content, msg.ts);
    handle.setFooter(reactionFooter(msg.id));
    bubbleHandles.set(msg.id, handle);
  }

  /** Repaint the channel timeline from cache: root bubbles, threads as one live summary line each. */
  function renderChannelTimeline(channelId: string): void {
    api.ui.clearLog();
    bubbleHandles = new Map();
    summaryLineHandles = new Map();
    draftBubbles.clear();
    const list = messagesByChannel.get(channelId) ?? [];
    const summarized = new Set<string>();
    for (const msg of list) {
      if (!msg.parentId) {
        paintBubble(msg);
        continue;
      }
      const rootId = msg.rootId!;
      if (summarized.has(rootId)) continue;
      summarized.add(rootId);
      updateOrAppendSummaryLine(channelId, rootId);
    }
  }

  /** Repaint as a single thread: root bubble, replies in arrival order, indented. */
  function renderThreadView(channelId: string, rootId: string): void {
    api.ui.clearLog();
    bubbleHandles = new Map();
    summaryLineHandles = new Map();
    draftBubbles.clear();
    const no = threadNo(rootId);
    const root = msgById.get(rootId);
    if (root) paintBubble(root);
    for (const msg of threadReplies(channelId, rootId)) bubbleHandles.set(msg.id, threadBubble(msg));
    api.ui.notify(`— in thread #${no}: plain messages reply here, /back returns to #channel —`);
  }

  /** The job board — per-agent work assembled from wire events; repaints live while open. */
  function renderJobsView(): void {
    api.ui.clearLog();
    bubbleHandles = new Map();
    summaryLineHandles = new Map();
    draftBubbles.clear();

    const byAgent = new Map<string, Job[]>();
    for (const job of jobs.values()) {
      const list = byAgent.get(job.agentPk) ?? [];
      list.push(job);
      byAgent.set(job.agentPk, list);
    }
    if (byAgent.size === 0 && workflowRuns.size === 0) {
      api.ui.appendMessage("jobs", "No agent work seen this session — mention an agent (or @fez) and its job will appear here.");
      api.ui.notify("— /back returns to the channel —");
      return;
    }
    const GLYPH: Record<Job["status"], string> = { seen: "👀", working: "⚙", done: "✓", failed: "✗", steered: "🔀" };
    const age = (ms: number) => {
      const s = Math.max(0, Math.round(ms / 1000));
      return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
    };
    const now = Date.now();
    for (const [pk, list] of byAgent) {
      list.sort((a, b) => b.startedAt - a.startedAt);
      const open = list.filter((j) => j.status === "seen" || j.status === "working").length;
      const done = list.filter((j) => j.status === "done").length;
      const lines = list.slice(0, 8).map((job) => {
        const dur = job.endedAt ? age(job.endedAt - job.startedAt) : age(now - job.startedAt);
        const tool = job.currentTool ? ` · ${job.currentTool}` : "";
        const thread = threadNoByRoot.has(job.rootId) ? ` — /thread ${threadNo(job.rootId)}` : "";
        const stale =
          (job.status === "seen" || job.status === "working") && now - job.startedAt > 30 * 60_000 ? " (stalled?)" : "";
        return `${GLYPH[job.status]} ${dur}${tool} "${job.snippet}"${stale}${thread}`;
      });
      api.ui.appendMessage(`@${displayName(pk)} — ${open} active · ${done} done`, lines.join("\n"));
    }
    if (workflowRuns.size > 0) {
      const runs = [...workflowRuns.values()]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 8)
        .map((r) => `${r.workflow}: ${r.status}${r.step ? ` (step ${r.step})` : ""} · ${age(now - r.ts)} ago`);
      api.ui.appendMessage("automations", runs.join("\n"));
    }
    api.ui.notify("— live · /back returns to the channel —");
  }

  function absorb(event: NostrEvent): void {
    if (state.absorb(event)) refreshUi();
  }

  function handleIncomingMessage(event: NostrEvent): void {
    if (seenMessages.has(event.id)) return;
    seenMessages.add(event.id);
    // A real message from someone clears their typing indicators immediately
    // (Buzz does the same rather than waiting out the TTL).
    for (const key of typing.keys()) if (key.startsWith(`${event.pubkey}:`)) typing.delete(key);
    renderTyping();
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId) return;
    if (!state.isMember(communityId, channelId, event.pubkey)) return; // client-side gate

    const msg = cacheMessage(channelId, event, event.pubkey === nostr!.pubkey ? "You" : displayName(event.pubkey));

    // A threaded reply closes its author's job on the message it answers
    // (falling back to the thread root — some agents reply to the root).
    if (msg.parentId) {
      for (const anchor of [msg.parentId, msg.rootId]) {
        const job = anchor ? jobs.get(`${event.pubkey}:${anchor}`) : undefined;
        if (job && job.status !== "done") {
          job.status = "done";
          job.endedAt = event.created_at * 1000;
          job.currentTool = undefined;
          jobsChanged();
          break;
        }
      }
    }

    if (event.pubkey === nostr!.pubkey) return; // own message, already echoed on send

    const scope = state.scope;
    if (!scope || scope.channelId !== channelId || scope.communityId !== communityId) return;

    // Buzz's timeline rule, TUI-shaped: the main view shows roots as
    // bubbles and collapses replies into thread summaries; the thread view
    // shows its own replies as indented bubbles and everything else as a
    // compact line so the thread stays coherent.
    if (view.mode === "watch") {
      api.ui.notify(`(in #channel: ${msg.authorName}: ${snippet(msg.content)})`);
      return;
    }
    if (view.mode === "jobs") return; // the board repaints itself via jobsChanged

    if (view.mode === "thread") {
      if (msg.rootId === view.rootId) {
        // Adopt the author's streaming draft bubble as this message's
        // bubble — the stream simply "finishes" instead of duplicating.
        const draft = draftBubbles.get(event.pubkey);
        if (draft && draft.rootId === msg.rootId) {
          draft.handle.setContent(msg.content);
          draft.handle.setFooter(reactionFooter(msg.id));
          bubbleHandles.set(msg.id, draft.handle);
          draftBubbles.delete(event.pubkey);
        } else {
          bubbleHandles.set(msg.id, threadBubble(msg));
        }
      } else {
        api.ui.notify(`(in #channel: ${msg.authorName}: ${snippet(msg.content)})`);
      }
      return;
    }
    if (!msg.parentId) {
      bubbleHandles.set(msg.id, api.ui.appendMessage(msg.authorName, msg.content, msg.ts));
    } else {
      // The final message ends this author's draft in that thread.
      draftersByRoot.get(msg.rootId!)?.delete(event.pubkey);
      updateOrAppendSummaryLine(channelId, msg.rootId!, msg);
    }
  }

  /**
   * Thread activity in the channel view: one live summary line per thread,
   * updated in place via its MessageHandle — new replies bump the count
   * and latest-author snippet instead of appending another line.
   */
  /**
   * Thread info rides the ROOT message's own action footer (setMeta):
   * `⧉ copy  ↩ quote  ·  3 replies · /thread 40` — Ken's block model,
   * one footer per message carrying everything you can do with it.
   * /thread N is a clickable link. Only when the root isn't rendered
   * (its page not loaded yet) does a bare └─ connector stand in.
   */
  function threadMeta(channelId: string, rootId: string): string {
    const no = threadNo(rootId);
    const count = threadReplyCount(channelId, rootId);
    // The link label is dimmed too — an undimmed OSC-8 label rendered
    // full-brightness and made the whole footer read louder than the text.
    return DIM(`${count} repl${count === 1 ? "y" : "ies"} · `) + OSC8(`fez-thread://open/${no}`, DIM(`/thread ${no}`));
  }

  // ── Message ops (Buzz's stream-message family): edits, pins,
  // bookmarks. Everything a message accumulates surfaces on its own
  // footer meta — edited marker, ⚑ pin, thread info — one line.
  const pinsByChannel = new Map<string, Map<string, { opId: string; by: string; ts: number }>>();
  const myBookmarks = new Map<string, { opId: string; ts: number; channelId: string }>();
  /** op event id -> what it did, for kind-5 retraction (author-only). */
  const opIndex = new Map<string, { type: "pin" | "bookmark"; channelId: string; targetId: string; by: string }>();

  function messageMeta(channelId: string, msgId: string): string {
    const parts: string[] = [];
    if (msgById.get(msgId)?.edited) parts.push(DIM("edited"));
    if (pinsByChannel.get(channelId)?.has(msgId)) parts.push(DIM("⚑ pinned"));
    if (threadReplyCount(channelId, msgId) > 0) parts.push(threadMeta(channelId, msgId));
    return parts.join(DIM("  ·  "));
  }

  /** 40003 — author-only, latest edit wins; content swaps in place, "edited" rides the footer. */
  function handleMsgEdit(event: NostrEvent): void {
    const targetId = event.tags.find((t) => t[0] === "e")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!targetId || !channelId) return;
    const target = msgById.get(targetId);
    if (!target || event.pubkey !== target.authorPk) return;
    if (event.created_at < (target.editTs ?? 0)) return;
    target.content = event.content;
    target.edited = true;
    target.editTs = event.created_at;
    const handle = bubbleHandles.get(targetId);
    if (handle) {
      handle.setContent(event.content);
      handle.setMeta(messageMeta(channelId, targetId));
    }
  }

  /** 40004 — member-gated channel pin. */
  function handleMsgPin(event: NostrEvent): void {
    const targetId = event.tags.find((t) => t[0] === "e")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!targetId || !channelId || !communityId) return;
    if (!state.isMember(communityId, channelId, event.pubkey)) return;
    let pins = pinsByChannel.get(channelId);
    if (!pins) pinsByChannel.set(channelId, (pins = new Map()));
    pins.set(targetId, { opId: event.id, by: event.pubkey, ts: event.created_at });
    opIndex.set(event.id, { type: "pin", channelId, targetId, by: event.pubkey });
    bubbleHandles.get(targetId)?.setMeta(messageMeta(channelId, targetId));
  }

  /** 40005 — personal: only YOUR bookmarks are tracked/rendered. */
  function handleMsgBookmark(event: NostrEvent): void {
    if (event.pubkey !== nostr!.pubkey) return;
    const targetId = event.tags.find((t) => t[0] === "e")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1] ?? "";
    if (!targetId) return;
    myBookmarks.set(targetId, { opId: event.id, ts: event.created_at, channelId });
    opIndex.set(event.id, { type: "bookmark", channelId, targetId, by: event.pubkey });
  }

  function updateOrAppendSummaryLine(channelId: string, rootId: string, _latest?: Msg): void {
    const root = bubbleHandles.get(rootId);
    if (root) {
      root.setMeta(messageMeta(channelId, rootId));
      return;
    }
    const text = DIM("└─ ") + threadMeta(channelId, rootId);
    const existing = summaryLineHandles.get(rootId);
    if (existing) {
      existing.setContent(text);
    } else {
      summaryLineHandles.set(rootId, api.ui.appendMessage("", text, undefined, { bare: true }));
    }
  }

  api.registerUrlHandler("fez-thread://open/", (url) => {
    const no = Number(url.slice("fez-thread://open/".length));
    const rootId = rootByThreadNo.get(no);
    const current = state.currentChannel();
    if (!rootId || !current) return;
    view = { mode: "thread", rootId };
    renderThreadView(current.channel.id, rootId);
    refreshUi();
  });

  /** Reactions (kind 7, Buzz's shape) — land live on the target's bubble footer. `live=false` for history replay: fold into footers but never open jobs (a stored 👀 from last week is not an active job). */
  function handleReaction(event: NostrEvent, live = true): void {
    const targetId = event.tags.find((t) => t[0] === "e")?.[1];
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!targetId || !channelId || !communityId) return;
    if (!state.isMember(communityId, channelId, event.pubkey)) return; // trust rule
    const emoji = event.content.trim();
    if (!emoji || emoji.length > 8) return;
    let byEmoji = reactionsByTarget.get(targetId);
    if (!byEmoji) reactionsByTarget.set(targetId, (byEmoji = new Map()));
    let who = byEmoji.get(emoji);
    if (!who) byEmoji.set(emoji, (who = new Set()));
    who.add(displayName(event.pubkey));
    reactionIndex.set(event.id, { targetId, emoji, authorPk: event.pubkey });
    bubbleHandles.get(targetId)?.setFooter(reactionFooter(targetId));

    // Status reactions open jobs: 👀 = accepted (seen), 💬 = turn running.
    if (live && (emoji === "👀" || emoji === "💬")) {
      const key = `${event.pubkey}:${targetId}`;
      const existing = jobs.get(key);
      if (existing) {
        if (emoji === "💬" && existing.status !== "working" && existing.status !== "done") {
          existing.status = "working";
          jobsChanged();
        }
      } else {
        const trigger = msgById.get(targetId);
        jobs.set(key, {
          triggerId: targetId,
          agentPk: event.pubkey,
          channelId,
          status: emoji === "💬" ? "working" : "seen",
          startedAt: event.created_at * 1000,
          rootId: trigger?.rootId ?? targetId,
          snippet: snippet(trigger?.content ?? "(message not seen)", 48),
        });
        trimJobs();
        jobsChanged();
      }
    }
  }

  // Streaming drafts (ephemeral 20003): one live bubble per author,
  // growing with each draft, adopted as the real message's bubble when the
  // final 47103 lands (matched by author) — pi-style typing over the relay.
  const draftBubbles = new Map<string, { handle: MessageHandle; rootId?: string }>();
  // rootId -> pubkey -> latest draft snippet: concurrent drafters into the
  // same thread aggregate on its summary line instead of overwriting each
  // other per frame.
  const draftersByRoot = new Map<string, Map<string, string>>();

  function handleDraft(event: NostrEvent): void {
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId || !event.content) return;
    if (event.pubkey === nostr!.pubkey) return;
    if (!state.isMember(communityId, channelId, event.pubkey)) return;
    const scope = state.scope;
    if (!scope || scope.channelId !== channelId) return;
    const { rootId } = parseThreadRef(event.tags);

    // Streaming renders where the final message will land: as a bubble in
    // a matching thread view; as the live summary-line snippet in channel
    // view (agent replies are thread children, so their final form there
    // is the summary line).
    if (view.mode === "thread" && rootId === view.rootId) {
      let draft = draftBubbles.get(event.pubkey);
      if (!draft) {
        const handle = api.ui.appendMessage(displayName(event.pubkey), event.content);
        handle.setFooter("✍ typing…");
        draft = { handle, rootId };
        draftBubbles.set(event.pubkey, draft);
      } else {
        draft.handle.setContent(event.content);
      }
      // Streaming text supersedes the typing indicator for this author.
      for (const key of typing.keys()) if (key.startsWith(`${event.pubkey}:`)) typing.delete(key);
      renderTyping();
    } else if (view.mode === "channel" && rootId) {
      const no = threadNo(rootId);
      let drafters = draftersByRoot.get(rootId);
      if (!drafters) draftersByRoot.set(rootId, (drafters = new Map()));
      drafters.set(event.pubkey, snippet(event.content, 60));
      const meta =
        DIM(
          drafters.size === 1
            ? `✍ ${displayName(event.pubkey)}: ${drafters.get(event.pubkey)} · `
            : `✍ ${[...drafters.keys()].map(displayName).join(", ")} are replying… · `
        ) + OSC8(`fez-thread://open/${no}`, DIM(`/thread ${no}`));
      const root = bubbleHandles.get(rootId);
      if (root) {
        root.setMeta(meta);
      } else {
        const existing = summaryLineHandles.get(rootId);
        if (existing) existing.setContent(DIM("└─ ") + meta);
        else summaryLineHandles.set(rootId, api.ui.appendMessage("", DIM("└─ ") + meta, undefined, { bare: true }));
      }
    }
  }

  /** Kind-5 deletion — only honored for the deleter's own reactions/ops (standard nostr rule). */
  function handleDeletion(event: NostrEvent): void {
    for (const tag of event.tags) {
      if (tag[0] !== "e" || !tag[1]) continue;
      // Message-op retraction (unpin, un-bookmark) — author-only.
      const op = opIndex.get(tag[1]);
      if (op && op.by === event.pubkey) {
        opIndex.delete(tag[1]);
        if (op.type === "pin") {
          pinsByChannel.get(op.channelId)?.delete(op.targetId);
          bubbleHandles.get(op.targetId)?.setMeta(messageMeta(op.channelId, op.targetId));
        } else {
          myBookmarks.delete(op.targetId);
        }
        continue;
      }
      const entry = reactionIndex.get(tag[1]);
      if (!entry || entry.authorPk !== event.pubkey) continue;
      reactionIndex.delete(tag[1]);
      const who = reactionsByTarget.get(entry.targetId)?.get(entry.emoji);
      who?.delete(displayName(entry.authorPk));
      if (who && who.size === 0) reactionsByTarget.get(entry.targetId)?.delete(entry.emoji);
      bubbleHandles.get(entry.targetId)?.setFooter(reactionFooter(entry.targetId));
    }
  }

  function handleTyping(event: NostrEvent): void {
    if (event.pubkey === nostr!.pubkey) return;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId || state.scope?.channelId !== channelId) return;
    const { rootId } = parseThreadRef(event.tags);
    typing.set(`${event.pubkey}:${rootId ?? "channel"}`, {
      pubkey: event.pubkey,
      threadRoot: rootId,
      expiry: Date.now() + TYPING_TTL_MS,
    });
    renderTyping();
  }

  // Channel-id snapshot of the LIVE subscription — the loop guard above
  // compares against it before resubscribing.
  let subscribedChannelIds = "";

  function resubscribe(): void {
    unsubscribe?.();
    subscribedChannelIds = channelIdsOfJoined().sort().join(",");
    const ids = [...state.joined];
    const filters: NostrFilter[] = [
      { kinds: [KIND_AGENT_METADATA], since: Math.floor(Date.now() / 1000) - 7 * 86400 },
    ];
    if (ids.length > 0) {
      filters.push(
        { kinds: [KIND_COMMUNITY, KIND_CHANNEL, KIND_MEMBERSHIP], "#c": ids },
        { kinds: [KIND_COMMUNITY], "#d": ids },
        { kinds: [KIND_CHANNEL_MESSAGE, KIND_TYPING, KIND_REACTION, KIND_DELETION, KIND_DRAFT, KIND_WORKFLOW_RUN, KIND_DOC, KIND_MSG_EDIT, KIND_MSG_PIN, KIND_MSG_BOOKMARK], "#h": channelIdsOfJoined(), since: Math.floor(Date.now() / 1000) },
        { kinds: [KIND_THREAD_SUMMARY], "#h": channelIdsOfJoined() }
      );
    }
    unsubscribe = nostr!.subscribe(filters, (event) => {
      if (event.kind === KIND_TYPING) {
        handleTyping(event);
        return;
      }
      if (event.kind === KIND_WORKFLOW_RUN) {
        handleWorkflowRun(event);
        return;
      }
      if (event.kind === KIND_THREAD_SUMMARY) {
        handleThreadSummary(event);
        return;
      }
      if (event.kind === KIND_REACTION) {
        handleReaction(event);
        return;
      }
      if (event.kind === KIND_DELETION) {
        handleDeletion(event);
        return;
      }
      if (event.kind === KIND_DRAFT) {
        handleDraft(event);
        return;
      }
      if (event.kind === KIND_MSG_EDIT) {
        handleMsgEdit(event);
        return;
      }
      if (event.kind === KIND_MSG_PIN) {
        handleMsgPin(event);
        return;
      }
      if (event.kind === KIND_MSG_BOOKMARK) {
        handleMsgBookmark(event);
        return;
      }
      if (event.kind === KIND_DOC) {
        const channelId = absorbDocEvent(event);
        const communityId = event.tags.find((t) => t[0] === "c")?.[1];
        if (!channelId || !communityId) return;
        refreshDocsPanel();
        mirrorWrite(channelId);
        if (state.scope?.channelId !== channelId) return;
        if (view.mode === "doc") {
          // Live re-render — an agent editing while you read is the point.
          void docVersions(channelId, communityId).then((versions) => {
            if (view.mode !== "doc" || state.scope?.channelId !== channelId) return;
            renderDocView(versions.at(-1), versions.length, versions.length, state.currentChannel()?.channel.name ?? "?");
          });
        } else if (event.pubkey !== nostr!.pubkey) {
          api.ui.notify(`📄 ${displayName(event.pubkey)} updated the channel doc — /doc`);
        }
        return;
      }
      if (event.kind === KIND_AGENT_METADATA) {
        try {
          const name = JSON.parse(event.content).name;
          if (name && names.get(event.pubkey) !== name) {
            names.set(event.pubkey, name);
            // Panels resolved this pubkey before the announcement arrived
            // (seen live as a raw hex id in the DMS box) — re-render now
            // that it has a name.
            refreshDmPanel();
            refreshDocsPanel();
          }
        } catch { /* ignore */ }
        return;
      }
      if (event.kind === KIND_CHANNEL_MESSAGE) {
        handleIncomingMessage(event);
        return;
      }
      absorb(event);
      // Membership/channel changes can add channels — refresh the live
      // message subscription so new channels stream immediately. ONLY
      // when the channel set actually changed: the subscription's
      // community/channel filters replay history (no `since`), so
      // resubscribing on every 47101 re-triggers itself on the replayed
      // 47101s — a feedback loop observed live pinning the TUI at 98%
      // CPU (each cycle re-verifies every stored event's signature).
      if (event.kind === KIND_CHANNEL) {
        const ids = channelIdsOfJoined().sort().join(",");
        if (ids !== subscribedChannelIds) resubscribe();
      }
    });
  }

  function channelIdsOfJoined(): string[] {
    const ids: string[] = [];
    for (const communityId of state.joined) {
      const community = state.community(communityId);
      if (community) ids.push(...community.channels.keys());
    }
    return ids;
  }

  /**
   * Backfill the scoped channel from relay storage — a fresh session
   * opens onto the conversation, not a blank pane. Messages render with
   * their REAL timestamps (date-prefixed when older than today); stored
   * reactions/deletions fold into footers but never open jobs (a 👀
   * from last week is history, not an active turn). The live
   * subscription's since:now takes over from here; seenMessages dedupes
   * the overlap.
   */
  const HISTORY_LIMIT = 50;
  async function loadChannelHistory(channelId: string, communityId: string): Promise<void> {
    const [msgs, reactions, deletions, ops] = await Promise.all([
      nostr!.query([{ kinds: [KIND_CHANNEL_MESSAGE], "#h": [channelId], limit: 200 }]),
      nostr!.query([{ kinds: [KIND_REACTION], "#h": [channelId], limit: 300 }]),
      nostr!.query([{ kinds: [KIND_DELETION], "#h": [channelId], limit: 300 }]),
      nostr!.query([{ kinds: [KIND_MSG_EDIT, KIND_MSG_PIN, KIND_MSG_BOOKMARK], "#h": [channelId], limit: 300 }]),
    ]);
    const ordered = msgs
      .filter((e) => state.isMember(communityId, channelId, e.pubkey))
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-HISTORY_LIMIT);
    for (const event of ordered) {
      if (seenMessages.has(event.id)) continue;
      seenMessages.add(event.id);
      cacheMessage(channelId, event, event.pubkey === nostr!.pubkey ? "You" : displayName(event.pubkey));
    }
    // Edits fold into the cache BEFORE painting; pins/bookmarks after
    // (they land on rendered bubbles' meta). Deletions last so
    // retracted ops disappear.
    for (const event of ops.filter((e) => e.kind === KIND_MSG_EDIT).sort((a, b) => a.created_at - b.created_at)) handleMsgEdit(event);
    if (view.mode === "channel" && state.scope?.channelId === channelId) renderChannelTimeline(channelId);
    for (const event of reactions.sort((a, b) => a.created_at - b.created_at)) handleReaction(event, false);
    for (const event of ops) {
      if (event.kind === KIND_MSG_PIN) handleMsgPin(event);
      else if (event.kind === KIND_MSG_BOOKMARK) handleMsgBookmark(event);
    }
    for (const event of deletions) handleDeletion(event);
    refreshUi();
  }

  // ── Scroll-up paging (Buzz's channel window, dumb-relay-shaped):
  // parking the view at the top pulls the previous page with an
  // `until` filter. nostr filters can't express Buzz's composite
  // (created_at, id) keyset cursor, so `until` (inclusive) overlaps the
  // boundary second and seenMessages dedupes the ties — same safety,
  // client-side. Exhaustion uses Buzz's limit+1 probe: a short page
  // proves nothing on an exact-multiple final page, a missing sentinel
  // row does.
  const PAGE_SIZE = 50;
  const exhaustedChannels = new Set<string>();

  async function loadOlderPage(channelId: string, communityId: string): Promise<void> {
    const list = messagesByChannel.get(channelId) ?? [];
    const oldest = list[0]?.ts;
    if (!oldest) return;
    const events = await nostr!.query([
      { kinds: [KIND_CHANNEL_MESSAGE], "#h": [channelId], until: oldest, limit: PAGE_SIZE + 1 },
    ]);
    if (events.length <= PAGE_SIZE) exhaustedChannels.add(channelId);
    const fresh = events
      .filter((e) => !seenMessages.has(e.id) && state.isMember(communityId, channelId, e.pubkey))
      .sort((a, b) => a.created_at - b.created_at);
    if (fresh.length === 0) {
      // Nothing but boundary overlap — no forward progress possible.
      exhaustedChannels.add(channelId);
    }

    // Cache-prepend, oldest-first ahead of the existing window.
    const freshMsgs: Msg[] = [];
    for (const event of fresh) {
      seenMessages.add(event.id);
      const { parentId, rootId } = parseThreadRef(event.tags);
      const msg: Msg = {
        id: event.id,
        authorPk: event.pubkey,
        authorName: event.pubkey === nostr!.pubkey ? "You" : displayName(event.pubkey),
        content: event.content,
        parentId,
        rootId,
        ts: event.created_at,
      };
      freshMsgs.push(msg);
      msgById.set(msg.id, msg);
      if (rootId) threadNo(rootId);
    }
    messagesByChannel.set(channelId, [...freshMsgs, ...list].slice(-MSG_CACHE_CAP));

    if (view.mode !== "channel" || state.scope?.channelId !== channelId) return;
    // Prepend newest-of-the-old first so the final order reads
    // chronologically: roots as bubbles; replies bump their thread's
    // existing summary line in place, or mint one if the thread is new
    // to the view. Replies whose root is still unloaded stay silent —
    // the root's page will bring the thread with it.
    const summarized = new Set<string>();
    for (const msg of [...freshMsgs].reverse()) {
      if (!msg.parentId) {
        const handle = api.ui.prependMessage(msg.authorName, msg.content, msg.ts);
        handle.setFooter(reactionFooter(msg.id));
        bubbleHandles.set(msg.id, handle);
        continue;
      }
      const rootId = msg.rootId!;
      if (summaryLineHandles.has(rootId)) {
        if (!summarized.has(rootId)) updateOrAppendSummaryLine(channelId, rootId);
        summarized.add(rootId);
      } else if (bubbleHandles.has(rootId) && !summarized.has(rootId)) {
        summarized.add(rootId);
        bubbleHandles.get(rootId)!.setMeta(threadMeta(channelId, rootId));
      } else if (!summarized.has(rootId)) {
        summarized.add(rootId);
        summaryLineHandles.set(
          rootId,
          api.ui.prependMessage("", DIM("└─ ") + threadMeta(channelId, rootId), undefined, { bare: true })
        );
      }
    }
    if (exhaustedChannels.has(channelId)) {
      api.ui.prependMessage("", DIM(`— beginning of the channel — nothing older on the relay —`), undefined, { bare: true });
    }
  }

  api.ui.onLogScrollTop(async () => {
    if (view.mode !== "channel") return;
    const current = state.currentChannel();
    if (!current || exhaustedChannels.has(current.channel.id)) return;
    await loadOlderPage(current.channel.id, current.community.id);
  });

  async function syncJoined(): Promise<void> {
    const ids = [...state.joined];
    if (ids.length === 0) return;
    const events = await nostr!.query([
      { kinds: [KIND_COMMUNITY], "#d": ids },
      { kinds: [KIND_CHANNEL, KIND_MEMBERSHIP], "#c": ids },
    ]);
    // Communities first (root of trust), then channels, then memberships.
    for (const kind of [KIND_COMMUNITY, KIND_CHANNEL, KIND_MEMBERSHIP]) {
      for (const event of events.filter((e) => e.kind === kind)) state.absorb(event);
    }
    refreshUi();
  }

  // ── Private DMs (NIP-17 gift wraps — crypto lives behind
  // nostr.sendDm/unwrapDm, see fez src/dm.ts; this is pure view state).
  // The wrap subscription reaches DM_FUZZ_WINDOW_S back because wrap
  // timestamps are fuzzed BACKWARDS — a since-now filter would drop live
  // messages. The replay this causes doubles as history restore: each
  // session recovers up to 2 days of conversation, silently (no unread,
  // no notify for anything older than this session).
  interface DmMsg {
    id: string;
    senderPk: string;
    text: string;
    ts: number;
  }
  const dmConvos = new Map<string, { msgs: DmMsg[]; unread: number }>();
  const seenDmIds = new Set<string>();
  const sessionStartS = Math.floor(Date.now() / 1000);
  const OSC8 = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;

  function dmConvo(peerPk: string): { msgs: DmMsg[]; unread: number } {
    let convo = dmConvos.get(peerPk);
    if (!convo) dmConvos.set(peerPk, (convo = { msgs: [], unread: 0 }));
    return convo;
  }

  function refreshDmPanel(): void {
    if (dmConvos.size === 0) {
      dmPanel.setText(" (none — /dm <agent>)");
      return;
    }
    const lines = [...dmConvos.entries()]
      .sort((a, b) => (b[1].msgs.at(-1)?.ts ?? 0) - (a[1].msgs.at(-1)?.ts ?? 0))
      .slice(0, 12)
      .map(([pk, c]) => ` ${OSC8(`fez-dm://open/${pk}`, `@${displayName(pk)}`)}${c.unread > 0 ? ` (${c.unread})` : ""}`);
    dmPanel.setText(lines.join("\n"));
  }

  function renderDmView(peerPk: string): void {
    api.ui.clearLog();
    bubbleHandles = new Map();
    summaryLineHandles = new Map();
    draftBubbles.clear();
    api.ui.notify(`— private DM with @${displayName(peerPk)} · end-to-end encrypted, no channel involved · plain messages send here, /back returns —`);
    for (const m of dmConvo(peerPk).msgs) {
      api.ui.appendMessage(m.senderPk === nostr!.pubkey ? "You" : displayName(m.senderPk), m.text, m.ts);
    }
  }

  function openDm(peerPk: string): void {
    view = { mode: "dm", peerPk };
    dmConvo(peerPk).unread = 0;
    renderDmView(peerPk);
    refreshDmPanel();
    refreshUi();
  }

  function handleGiftWrap(event: NostrEvent): void {
    const dm = nostr!.unwrapDm(event);
    if (!dm || seenDmIds.has(dm.id)) return;
    seenDmIds.add(dm.id);
    const convo = dmConvo(dm.peerPk);
    convo.msgs.push({ id: dm.id, senderPk: dm.senderPk, text: dm.text, ts: dm.ts });
    convo.msgs.sort((a, b) => a.ts - b.ts);
    if (convo.msgs.length > 100) convo.msgs.splice(0, convo.msgs.length - 100);
    const live = dm.ts >= sessionStartS;
    if (view.mode === "dm" && view.peerPk === dm.peerPk) {
      if (live) api.ui.appendMessage(dm.senderPk === nostr!.pubkey ? "You" : displayName(dm.senderPk), dm.text, dm.ts);
    } else if (live && dm.senderPk !== nostr!.pubkey) {
      convo.unread++;
      api.ui.notify(`✉️  DM from ${displayName(dm.senderPk)}: ${snippet(dm.text)} — /dm ${displayName(dm.senderPk)}`);
    }
    refreshDmPanel();
  }

  api.registerCommand("dm", async (args, ctx) => {
    const target = args.trim().replace(/^@/, "");
    if (!target) {
      if (dmConvos.size === 0) {
        return ctx.reply("No DM conversations yet. /dm <agent-name|pubkey> starts one — private and end-to-end encrypted, no channel involved.");
      }
      return ctx.reply(
        [...dmConvos.entries()]
          .map(([pk, c]) => `• @${displayName(pk)}${c.unread > 0 ? ` — ${c.unread} unread` : ""} (/dm ${displayName(pk)})`)
          .join("\n")
      );
    }
    const peerPk = /^[0-9a-f]{64}$/i.test(target)
      ? target.toLowerCase()
      : [...names.entries()].find(([, n]) => n.toLowerCase() === target.toLowerCase())?.[0];
    if (!peerPk) return ctx.reply(`No one named "${target}" seen on this relay — a 64-char hex pubkey works for anyone unnamed.`);
    if (peerPk === nostr.pubkey) return ctx.reply("That's you.");
    openDm(peerPk);
  });

  api.registerUrlHandler("fez-dm://open/", (url) => openDm(url.slice("fez-dm://open/".length)));

  // ── Channel docs, standing state (the /doc command below is the view;
  // this is the sidebar + disk mirror). One entry per channel that has a
  // doc: version count and the latest member-authored version (base for
  // the next edit). The mirror keeps ~/.fez/docs/<community>/<channel>.md
  // in sync both ways — saving the file publishes the next version, so
  // any markdown editor (vim, VS Code, Obsidian-on-the-folder) is a doc
  // editor. Loop guard: we remember what we wrote; our own mirror writes
  // and our own published versions round-tripping through the relay
  // never re-publish.
  interface DocInfo {
    count: number;
    latestId: string;
    latestTs: number;
    latestAuthor: string;
    latestContent: string;
  }
  const docsByChannel = new Map<string, DocInfo>();
  const seenDocIds = new Set<string>();
  const DOCS_DIR = path.join(os.homedir(), ".fez", "docs");
  const mirrorPathByChannel = new Map<string, string>();
  const lastMirrored = new Map<string, string>();
  const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
  const sanitizeName = (s: string) => s.replace(/[^\w.-]+/g, "_");

  function channelRef(channelId: string): { communityId: string; name: string; communityName: string } | undefined {
    for (const communityId of state.joined) {
      const community = state.community(communityId);
      const channel = community?.channels.get(channelId);
      if (community && channel) return { communityId, name: channel.name, communityName: community.name };
    }
    return undefined;
  }

  function absorbDocEvent(event: NostrEvent): string | undefined {
    if (seenDocIds.has(event.id)) return undefined;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId || !state.isMember(communityId, channelId, event.pubkey)) return undefined;
    seenDocIds.add(event.id);
    let info = docsByChannel.get(channelId);
    if (!info) docsByChannel.set(channelId, (info = { count: 0, latestId: "", latestTs: 0, latestAuthor: "", latestContent: "" }));
    info.count++;
    if (event.created_at > info.latestTs || (event.created_at === info.latestTs && event.id < info.latestId)) {
      info.latestTs = event.created_at;
      info.latestId = event.id;
      info.latestAuthor = event.pubkey;
      info.latestContent = event.content;
    }
    return channelId;
  }

  function refreshDocsPanel(): void {
    const rows: string[] = [];
    for (const [channelId, info] of docsByChannel) {
      const ref = channelRef(channelId);
      if (!ref) continue;
      rows.push(` ${OSC8(`fez-doc://open/${channelId}`, `#${ref.name}`)} ${DIM(`v${info.count} · ${info.latestAuthor === nostr!.pubkey ? "you" : displayName(info.latestAuthor)}`)}`);
    }
    docsPanel.setText(rows.length > 0 ? rows.join("\n") : " (none — /doc set)");
  }

  function mirrorWrite(channelId: string): void {
    const info = docsByChannel.get(channelId);
    const ref = channelRef(channelId);
    if (!info || !ref) return;
    try {
      const dir = path.join(DOCS_DIR, sanitizeName(ref.communityName));
      const file = path.join(dir, `${sanitizeName(ref.name)}.md`);
      mirrorPathByChannel.set(channelId, file);
      if (lastMirrored.get(file) === info.latestContent) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, info.latestContent);
      lastMirrored.set(file, info.latestContent);
    } catch { /* disk trouble — the mirror is a convenience, the relay is canonical */ }
  }

  // Save-to-publish: watch the mirror folder; a changed .md that maps to
  // a known doc publishes the next version (base-tagged for conflict
  // visibility). Debounced — editors write files more than once per save.
  const watchDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  try {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.watch(DOCS_DIR, { recursive: true }, (_eventType, fname) => {
      if (!fname || !fname.toString().endsWith(".md")) return;
      const full = path.join(DOCS_DIR, fname.toString());
      clearTimeout(watchDebounce.get(full));
      watchDebounce.set(
        full,
        setTimeout(() => {
          const channelId = [...mirrorPathByChannel.entries()].find(([, p]) => p === full)?.[0];
          if (!channelId) return; // unmapped file — /doc set starts a doc, files don't
          let content: string;
          try {
            content = fs.readFileSync(full, "utf-8");
          } catch {
            return;
          }
          if (content === lastMirrored.get(full)) return; // our own write
          const info = docsByChannel.get(channelId);
          const ref = channelRef(channelId);
          if (!ref || content.trim() === (info?.latestContent ?? "").trim()) return;
          lastMirrored.set(full, content);
          void nostr!
            .publish({
              kind: KIND_DOC,
              tags: [["h", channelId], ["c", ref.communityId], ...(info?.latestId ? [["base", info.latestId]] : [])],
              content,
            })
            .then(() => api.ui.notify(`📄 ${path.basename(full)} saved → published doc v${(info?.count ?? 0) + 1} to #${ref.name}`))
            .catch(() => api.ui.notify(`⚠️ couldn't publish ${path.basename(full)} — relay unreachable?`));
        }, 400)
      );
    });
  } catch { /* fs.watch unavailable — mirror stays read-only */ }

  // Sidebar click → jump straight into that channel's doc view.
  api.registerUrlHandler("fez-doc://open/", (url) => {
    const channelId = url.slice("fez-doc://open/".length);
    const ref = channelRef(channelId);
    if (!ref) return;
    state.scope = { communityId: ref.communityId, channelId };
    state.save();
    void docVersions(channelId, ref.communityId).then((versions) => {
      view = { mode: "doc" };
      renderDocView(versions.at(-1), versions.length, versions.length, ref.name);
      refreshUi();
    });
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  api.registerCommand("community", async (args, ctx) => {
    const [sub, ...rest] = args.trim().split(/\s+/);

    if (sub === "create") {
      const name = rest.join(" ").trim();
      if (!name) return ctx.reply("Usage: /community create <name>");
      const communityId = crypto.randomUUID();
      const channelId = crypto.randomUUID();
      await nostr.publish({
        kind: KIND_COMMUNITY,
        tags: [["d", communityId]],
        content: JSON.stringify({ name }),
      });
      await nostr.publish({
        kind: KIND_CHANNEL,
        tags: [["d", channelId], ["c", communityId]],
        content: JSON.stringify({ name: "general", visibility: "open" }),
      });
      await nostr.publish({
        kind: KIND_MEMBERSHIP,
        tags: [["d", channelId], ["c", communityId], ["p", nostr.pubkey, "owner"]],
        content: "",
      });
      state.joined.add(communityId);
      state.scope = { communityId, channelId };
      state.save();
      await syncJoined();
      resubscribe();
      ctx.reply(`Created **${name}** with #general — you're in it.\nCommunity id (share to invite): \`${communityId}\``);
      return;
    }

    if (sub === "join") {
      const id = rest[0];
      if (!id) return ctx.reply("Usage: /community join <community-id>");
      state.joined.add(id);
      state.save();
      await syncJoined();
      resubscribe();
      const community = state.community(id);
      if (!community) return ctx.reply(`Joined ${id}, but no community metadata found on this relay yet.`);
      ctx.reply(`Joined **${community.name}**. Channels: ${[...community.channels.values()].map((c) => `#${c.name}`).join(", ") || "(none)"}\nNote: you can read, but others only see your messages once the creator /invites you.`);
      return;
    }

    if (sub === "list") {
      const events = await nostr.query([{ kinds: [KIND_COMMUNITY], limit: 50 }]);
      for (const e of events) state.absorb(e);
      const lines = [...state.communities.values()].map(
        (c) => `• **${c.name}** — \`${c.id}\`${state.joined.has(c.id) ? " (joined)" : ""}`
      );
      ctx.reply(lines.length > 0 ? lines.join("\n") : "No communities found on this relay.");
      return;
    }

    ctx.reply("Usage: /community create <name> | join <id> | list");
  });

  api.registerCommand("channels", async (_args, ctx) => {
    const lines: string[] = [];
    for (const id of state.joined) {
      const community = state.community(id);
      if (!community) continue;
      for (const channel of community.channels.values()) {
        lines.push(`• ${community.name}/#${channel.name} (${channel.members.size} members)\n  id: \`${channel.id}\``);
      }
    }
    ctx.reply(lines.length > 0 ? lines.join("\n") : "No channels — /community create <name> or /community join <id>");
  });

  api.registerCommand("join", async (args, ctx) => {
    const wanted = args.trim();
    if (!wanted) return ctx.reply("Usage: /join <channel-name>");
    for (const communityId of state.joined) {
      const channel = state.findChannelByName(communityId, wanted);
      if (channel) {
        state.scope = { communityId, channelId: channel.id };
        view = { mode: "channel" };
        state.save();
        refreshUi();
        ctx.reply(`Now in **#${channel.name}** — plain messages go to the channel. /leave to exit.`);
        await loadChannelHistory(channel.id, communityId);
        return;
      }
    }
    ctx.reply(`No channel named "${wanted}" in your joined communities.`);
  });

  api.registerCommand("leave", async (_args, ctx) => {
    if (!state.scope) return ctx.reply("Not in a channel.");
    state.scope = null;
    view = { mode: "channel" };
    state.save();
    refreshUi();
    ctx.reply("Left the channel — back to normal fez chat.");
  });

  api.registerCommand("thread", async (args, ctx) => {
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join <channel> first.");
    const no = Number(args.trim());
    const rootId = rootByThreadNo.get(no);
    if (!rootId) return ctx.reply(`No thread #${args.trim() || "?"} — /threads lists them.`);
    view = { mode: "thread", rootId };
    renderThreadView(current.channel.id, rootId);
    refreshUi();
  });

  api.registerCommand("threads", async (_args, ctx) => {
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join <channel> first.");
    const lines: string[] = [];
    for (const [no, rootId] of rootByThreadNo) {
      const count = threadReplyCount(current.channel.id, rootId);
      if (count === 0) continue;
      const replies = threadReplies(current.channel.id, rootId);
      const root = msgById.get(rootId);
      const latest = replies.at(-1)?.authorName;
      lines.push(
        `• #${no} "${snippet(root?.content ?? "(not seen — indexer summary)")}" — ${count} repl${count === 1 ? "y" : "ies"}${latest ? `, latest from ${latest}` : ""}`
      );
    }
    ctx.reply(lines.length > 0 ? lines.join("\n") : "No threads in this channel yet — replies start them.");
  });

  api.registerCommand("back", async (_args, ctx) => {
    if (view.mode === "channel") return ctx.reply("Not in a thread, watch, jobs, or DM view.");
    const current = state.currentChannel();
    view = { mode: "channel" };
    watchThoughtBubble = undefined;
    watchTextBubble = undefined;
    if (current) renderChannelTimeline(current.channel.id);
    else api.ui.clearLog();
    refreshUi();
  });

  // The owner's window into an agent's NIP-AE memory. The conversation
  // key is symmetric, so everything an agent remembers is readable here
  // by construction. Display-time lenient mirror of core's head
  // selection (extensions bundle standalone; the strict validation
  // lives in @fez/protocol and its evals).
  api.registerCommand("memory", async (args, ctx) => {
    const name = args.trim().replace(/^@/, "");
    if (!name) return ctx.reply("Usage: /memory <agent> — read that agent's persistent memory.");
    const agentPk = [...names.entries()].find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0];
    if (!agentPk) return ctx.reply(`No agent named "${name}" seen on this relay.`);
    const events = await nostr.query([{ kinds: [KIND_AGENT_ENGRAM], authors: [agentPk], "#p": [nostr.pubkey] }]);
    const byD = new Map<string, NostrEvent>();
    for (const event of events) {
      const d = event.tags.find((t) => t[0] === "d")?.[1];
      if (!d) continue;
      const prev = byD.get(d);
      if (!prev || event.created_at > prev.created_at || (event.created_at === prev.created_at && event.id < prev.id)) {
        byD.set(d, event);
      }
    }
    let core: string | undefined;
    const entries: { slug: string; value: string }[] = [];
    for (const event of byD.values()) {
      try {
        const body = JSON.parse(nostr.decrypt(event.pubkey, event.content));
        if (body.slug === "core" && typeof body.profile === "string") core = body.profile;
        else if (typeof body.slug === "string" && typeof body.value === "string") entries.push(body);
      } catch { /* not ours / garbage — ignorable */ }
    }
    if (!core && entries.length === 0) {
      return ctx.reply(`@${name} has no memory yet — it writes its own as it learns (or seed it: \`fez mem set --persona ${name} core "..."\`).`);
    }
    entries.sort((a, b) => a.slug.localeCompare(b.slug));
    ctx.reply(
      [
        `**@${name} — memory**`,
        core ? `**core**\n${core}` : "_(core not set)_",
        ...entries.map((b) => `**${b.slug}**\n${b.value}`),
      ].join("\n\n")
    );
  });

  // ── Channel doc (Buzz's canvas, decentralized). Query-on-demand: the
  // relay stores every 40100 version, so "the doc" is derived fresh each
  // view — no cache to go stale. Members-only versions count.
  async function docVersions(channelId: string, communityId: string): Promise<NostrEvent[]> {
    const events = await nostr!.query([{ kinds: [KIND_DOC], "#h": [channelId], limit: 200 }]);
    return events
      .filter((e) => state.isMember(communityId, channelId, e.pubkey))
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1)); // asc; ties: lowest id LAST = wins as latest
  }

  function renderDocView(doc: NostrEvent | undefined, versionNo: number, total: number, channelName: string): void {
    api.ui.clearLog();
    bubbleHandles = new Map();
    summaryLineHandles = new Map();
    draftBubbles.clear();
    if (!doc) {
      api.ui.appendMessage("doc", `#${channelName} has no doc yet. Start one: /doc set <text> — one living document per channel, editable by any member (agents included). /back returns.`);
      return;
    }
    api.ui.notify(`— #${channelName} doc · v${versionNo}/${total} · last edit by ${displayName(doc.pubkey)} — /doc history · /doc set|append <text> · /back —`);
    api.ui.appendMessage(displayName(doc.pubkey), doc.content, doc.created_at);
  }

  api.registerCommand("doc", async (args, ctx) => {
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join <channel> first.");
    const [sub, ...rest] = args.trim().split(/\s+/);
    const body = rest.join(" ");

    if (sub === "set" || sub === "append") {
      const text = args.trim().slice(sub.length).trim().replace(/\\n/g, "\n");
      if (!text) return ctx.reply(`Usage: /doc ${sub} <markdown — \\n for newlines>`);
      const versions = await docVersions(current.channel.id, current.community.id);
      const latest = versions.at(-1);
      const content = sub === "append" && latest ? `${latest.content}\n\n${text}` : text;
      await nostr.publish({
        kind: KIND_DOC,
        // base = the version this edit was made against — lets clients
        // SEE concurrent edits (two versions sharing a base = a fork)
        // instead of silently last-write-winning.
        tags: [["h", current.channel.id], ["c", current.community.id], ...(latest ? [["base", latest.id]] : [])],
        content,
      });
      ctx.reply(`📄 doc ${sub === "append" ? "appended" : "updated"} (v${versions.length + 1}). /doc to read.`);
      return;
    }

    if (sub === "history") {
      const versions = await docVersions(current.channel.id, current.community.id);
      if (versions.length === 0) return ctx.reply("No doc yet — /doc set <text> starts one.");
      // Fork visibility: two versions sharing a base were written
      // concurrently — the later one won, but neither is hidden.
      const baseOf = (v: NostrEvent) => v.tags.find((t) => t[0] === "base")?.[1];
      const childrenByBase = new Map<string, number>();
      for (const v of versions) {
        const b = baseOf(v);
        if (b) childrenByBase.set(b, (childrenByBase.get(b) ?? 0) + 1);
      }
      ctx.reply(
        versions
          .map((v, i) => {
            const b = baseOf(v);
            const fork = b && (childrenByBase.get(b) ?? 0) > 1 ? " ⑂ concurrent edit" : "";
            return `• v${i + 1} — ${displayName(v.pubkey)}, ${new Date(v.created_at * 1000).toLocaleString()} (${v.content.length} chars)${fork}${i === versions.length - 1 ? " ← current" : ` — /doc show ${i + 1}`}`;
          })
          .join("\n")
      );
      return;
    }

    if (sub === "show") {
      const versions = await docVersions(current.channel.id, current.community.id);
      const no = Number(rest[0]);
      const doc = versions[no - 1];
      if (!doc) return ctx.reply(`No v${rest[0] || "?"} — /doc history lists versions.`);
      view = { mode: "doc" };
      renderDocView(doc, no, versions.length, current.channel.name);
      refreshUi();
      return;
    }

    // Bare /doc — the living document.
    const versions = await docVersions(current.channel.id, current.community.id);
    view = { mode: "doc" };
    renderDocView(versions.at(-1), versions.length, versions.length, current.channel.name);
    refreshUi();
  });

  // ── Message ops commands. "Last message" targeting keeps the TUI
  // ergonomic — no message ids to type.
  function lastMessage(channelId: string, mine: boolean): Msg | undefined {
    const list = messagesByChannel.get(channelId) ?? [];
    return mine ? list.filter((m) => m.authorPk === nostr!.pubkey).at(-1) : list.at(-1);
  }

  api.registerCommand("edit", async (args, ctx) => {
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const text = args.trim().replace(/\\n/g, "\n");
    if (!text) return ctx.reply("Usage: /edit <new text> — replaces your most recent message here.");
    const target = lastMessage(current.channel.id, true);
    if (!target) return ctx.reply("No message of yours here to edit.");
    const event = await nostr.publish({
      kind: KIND_MSG_EDIT,
      tags: [["e", target.id], ["h", current.channel.id], ["c", current.community.id]],
      content: text,
    });
    handleMsgEdit(event);
    ctx.reply(`✏️ edited ("${snippet(text)}").`);
  });

  api.registerCommand("pin", async (_args, ctx) => {
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const target = lastMessage(current.channel.id, false);
    if (!target) return ctx.reply("Nothing here to pin.");
    if (pinsByChannel.get(current.channel.id)?.has(target.id)) return ctx.reply("Already pinned.");
    const event = await nostr.publish({
      kind: KIND_MSG_PIN,
      tags: [["e", target.id], ["h", current.channel.id], ["c", current.community.id]],
      content: "",
    });
    handleMsgPin(event);
    ctx.reply(`⚑ pinned ${target.authorName}: "${snippet(target.content)}" — /pins lists them.`);
  });

  api.registerCommand("pins", async (_args, ctx) => {
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const pins = [...(pinsByChannel.get(current.channel.id) ?? new Map()).entries()];
    if (pins.length === 0) return ctx.reply("No pins in this channel — /pin pins the latest message.");
    ctx.reply(
      pins
        .map(([targetId, pin], i) => {
          const msg = msgById.get(targetId);
          return `${i + 1}. ${msg ? `${msg.authorName}: "${snippet(msg.content, 60)}"` : "(message not loaded)"} — pinned by ${pin.by === nostr.pubkey ? "you" : displayName(pin.by)}${pin.by === nostr.pubkey ? ` (/unpin ${i + 1})` : ""}`;
        })
        .join("\n")
    );
  });

  api.registerCommand("unpin", async (args, ctx) => {
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const pins = [...(pinsByChannel.get(current.channel.id) ?? new Map()).entries()];
    const pick = pins[Number(args.trim()) - 1];
    if (!pick) return ctx.reply("Usage: /unpin <number from /pins>");
    const [, pin] = pick;
    if (pin.by !== nostr.pubkey) return ctx.reply("Only the pinner can unpin.");
    const event = await nostr.publish({
      kind: KIND_DELETION,
      tags: [["e", pin.opId], ["h", current.channel.id], ["c", current.community.id]],
      content: "",
    });
    handleDeletion(event);
    ctx.reply("⚑ unpinned.");
  });

  api.registerCommand("bookmark", async (_args, ctx) => {
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const target = lastMessage(current.channel.id, false);
    if (!target) return ctx.reply("Nothing here to bookmark.");
    const event = await nostr.publish({
      kind: KIND_MSG_BOOKMARK,
      tags: [["e", target.id], ["h", current.channel.id], ["c", current.community.id]],
      content: "",
    });
    handleMsgBookmark(event);
    ctx.reply(`🔖 bookmarked "${snippet(target.content)}" — /bookmarks lists yours.`);
  });

  api.registerCommand("bookmarks", async (_args, ctx) => {
    if (myBookmarks.size === 0) return ctx.reply("No bookmarks — /bookmark saves the latest message in a channel.");
    ctx.reply(
      [...myBookmarks.entries()]
        .sort((a, b) => b[1].ts - a[1].ts)
        .map(([targetId, bm]) => {
          const msg = msgById.get(targetId);
          const where = channelRef(bm.channelId)?.name;
          return `• ${msg ? `${msg.authorName}: "${snippet(msg.content, 60)}"` : "(message not loaded)"}${where ? ` — #${where}` : ""}`;
        })
        .join("\n")
    );
  });

  api.registerCommand("jobs", async (_args, _ctx) => {
    view = { mode: "jobs" };
    refreshUi();
    renderJobsView();
  });

  api.registerCommand("watch", async (args, ctx) => {
    const agent = args.trim().replace(/^@/, "");
    if (!agent) return ctx.reply("Usage: /watch <agent-name> — live encrypted view of an agent you own. /back to leave.");
    view = { mode: "watch", agent };
    watchThoughtBubble = undefined;
    watchTextBubble = undefined;
    api.ui.clearLog();
    const feed = observerFeeds.get(agent) ?? [];
    api.ui.appendMessage(
      "communities",
      `— watching **@${agent}** (owner-encrypted activity; frames arrive while it works) — /back to leave —`
    );
    for (const entry of feed.slice(-10)) {
      if (entry.type === "tool") api.ui.appendMessage("⚙", `${entry.title ?? "tool"}${entry.status ? ` — ${entry.status}` : ""}`);
      else if (entry.type === "turn") api.ui.notify(`— turn ${entry.status} —`);
    }
    refreshUi();
  });

  api.registerCommand("members", async (_args, ctx) => {
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join <channel> first.");
    const lines = [...current.channel.members.entries()].map(
      ([pubkey, role]) => `• ${displayName(pubkey)} (${role})${pubkey === nostr.pubkey ? " ← you" : ""}`
    );
    ctx.reply(lines.join("\n"));
  });

  api.registerCommand("invite", async (args, ctx) => {
    const [pubkey, role = "member"] = args.trim().split(/\s+/);
    if (!pubkey) return ctx.reply("Usage: /invite <pubkey> [member|admin|bot]");
    const current = state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join <channel> first.");
    if (current.community.creator !== nostr.pubkey) {
      return ctx.reply("Only the community creator can invite (v1).");
    }
    // Read-modify-write of the full membership list — the latest 47102 wins.
    const tags: string[][] = [
      ["d", current.channel.id],
      ["c", current.community.id],
      ...[...current.channel.members.entries()].map(([pk, r]) => ["p", pk, r]),
    ];
    if (!current.channel.members.has(pubkey)) tags.push(["p", pubkey, role as Role]);
    const event = await nostr.publish({ kind: KIND_MEMBERSHIP, tags, content: "" });
    state.absorb(event);
    refreshUi();
    ctx.reply(`Invited ${displayName(pubkey)} to #${current.channel.name} as ${role}.`);
  });

  // ── Chat input while scoped ──────────────────────────────────────────────

  api.registerInputHandler(async (text) => {
    // DM view: plain input goes over the private pipe, channel or not.
    if (view.mode === "dm") {
      const peerPk = view.peerPk;
      const id = await nostr.sendDm(peerPk, text);
      if (id) seenDmIds.add(id); // our self-copy echoes back via the subscription
      const convo = dmConvo(peerPk);
      convo.msgs.push({ id, senderPk: nostr.pubkey, text, ts: Math.floor(Date.now() / 1000) });
      api.ui.appendMessage("You", text);
      refreshDmPanel();
      return true;
    }

    const current = state.currentChannel();
    if (!current) return false;

    if (!current.channel.members.has(nostr.pubkey)) {
      api.ui.notify("⚠️  You're not in this channel's membership — other members won't see this until the creator /invites you.");
    }

    // @name tokens -> p tags, resolved against channel member display names.
    const mentions: string[] = [];
    for (const match of text.matchAll(/@([\w-]+)/g)) {
      const wanted = match[1].toLowerCase();
      for (const pubkey of current.channel.members.keys()) {
        if (displayName(pubkey).toLowerCase() === wanted) mentions.push(pubkey);
      }
    }

    // In a thread view, the message is a reply — Buzz's exact wire shape:
    // direct child of the root carries just the reply marker; deeper
    // replies carry root + reply markers (parent = latest thread message).
    const threadTags: string[][] = [];
    if (view.mode === "thread") {
      const replies = threadReplies(current.channel.id, view.rootId);
      const parentId = replies.at(-1)?.id ?? view.rootId;
      if (parentId !== view.rootId) threadTags.push(["e", view.rootId, "", "root"]);
      threadTags.push(["e", parentId, "", "reply"]);
    }

    const event = await nostr.publish({
      kind: KIND_CHANNEL_MESSAGE,
      tags: [
        ["h", current.channel.id],
        ["c", current.community.id],
        ...threadTags,
        ...mentions.map((pk) => ["p", pk]),
      ],
      content: text,
    });
    seenMessages.add(event.id);
    const msg = cacheMessage(current.channel.id, event, "You");
    // Register the echo bubble so incoming reactions (agents 👀-ing your
    // message) land on it live.
    bubbleHandles.set(msg.id, view.mode === "thread" ? threadBubble(msg) : api.ui.appendMessage("You", text));
    return true;
  });

  // ── Startup ──────────────────────────────────────────────────────────────

  // Observer frames are p-tagged to us and orthogonal to channel
  // subscriptions — one always-on subscription, tiny traffic (only while
  // owned agents work).
  nostr.subscribe([{ kinds: [KIND_OBSERVER], "#p": [nostr.pubkey] }], handleObserverFrame);

  // Gift wraps are p-tagged to us and orthogonal to channels — always-on,
  // window reaching back past the timestamp fuzz (see the DM section).
  nostr.subscribe(
    [{ kinds: [KIND_GIFT_WRAP], "#p": [nostr.pubkey], since: sessionStartS - DM_FUZZ_WINDOW_S }],
    handleGiftWrap
  );
  refreshDmPanel();

  void (async () => {
    const metadataEvents = await nostr.query([{ kinds: [KIND_AGENT_METADATA], limit: 200 }]);
    for (const event of metadataEvents) {
      try {
        const name = JSON.parse(event.content).name;
        if (name) names.set(event.pubkey, name);
      } catch { /* ignore */ }
    }
    refreshDmPanel(); // DM conversations replayed before names hydrated show hex ids otherwise

    // First-run bootstrap: a brand-new user (no saved state, nothing
    // joined) lands in a working room instead of an empty TUI — their
    // own Home community with #general, creator rights and membership
    // theirs from the first message. Existing users never hit this
    // (state file exists); a fresh user who meant to join elsewhere can
    // simply /leave.
    if (state.joined.size === 0 && !fs.existsSync(path.join(os.homedir(), ".fez", "communities.json"))) {
      const communityId = crypto.randomUUID();
      const channelId = crypto.randomUUID();
      try {
        await nostr.publish({ kind: KIND_COMMUNITY, tags: [["d", communityId]], content: JSON.stringify({ name: "Home" }) });
        await nostr.publish({
          kind: KIND_CHANNEL,
          tags: [["d", channelId], ["c", communityId]],
          content: JSON.stringify({ name: "general", visibility: "open" }),
        });
        await nostr.publish({
          kind: KIND_MEMBERSHIP,
          tags: [["d", channelId], ["c", communityId], ["p", nostr.pubkey, "owner"]],
          content: "",
        });
        state.joined.add(communityId);
        state.scope = { communityId, channelId };
        state.save();
        api.ui.notify("🏠 Created your Home community — you're in #general. Mention an agent (@researcher …) to get going; /help for the rest.");
      } catch { /* relay unreachable — the TUI's own error surface covers it */ }
    }

    await syncJoined();
    resubscribe();
    refreshUi();
    // Docs sidebar + disk mirror hydrate from stored versions.
    try {
      const docEvents = await nostr.query([{ kinds: [KIND_DOC], "#h": channelIdsOfJoined(), limit: 500 }]);
      for (const event of docEvents) absorbDocEvent(event);
      refreshDocsPanel();
      for (const channelId of docsByChannel.keys()) mirrorWrite(channelId);
    } catch { /* relay hiccup — the live stream fills the panel */ }
    // A fresh session opens onto the conversation, not a blank pane.
    const scope = state.scope;
    if (scope) await loadChannelHistory(scope.channelId, scope.communityId);
  })();
}

