import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FezExtensionAPI, MessageHandle, NostrEvent } from "./api-types.js";
import type { FezClient, Msg, Job } from "@fez/client";

/**
 * Fez communities — the TUI VIEW over @fez/client. All protocol state,
 * trust rules, and actions live in the client (api.client, one shared
 * instance per process); this file only renders and registers commands.
 * Docs and DMs are their OWN extensions (fez-docs, fez-dms) — this one
 * covers channels, threads, jobs, /watch, and message ops, and owns
 * the default "channel" view on the view bus (/back releases any
 * foreign view back to it).
 *
 * /community create <name> | list | join <id>
 * /channels | /join | /leave | /members | /invite
 * /thread(s) | /back | /watch | /jobs | /memory
 * /edit | /pin(s) | /unpin | /bookmark(s) | /schedule | /remind
 */
export default function communities(api: FezExtensionAPI): void {
  if (!api.client) return; // CLI subcommand context — nothing chat-shaped to do
  const client = api.client as FezClient;
  const views = api.ui.viewBus;

  const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
  const OSC8 = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
  const GREEN_DOT = "\x1b[32m●\x1b[39m";
  const presenceDot = (pk: string) => (client.isOnline(pk) ? GREEN_DOT : DIM("○"));

  function snippet(text: string, max = 40): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  }

  let view:
    | { mode: "channel" }
    | { mode: "thread"; rootId: string }
    | { mode: "watch"; agent: string }
    | { mode: "jobs" }
    /** A foreign extension (docs, dms) owns the log — we only notify. */
    | { mode: "external" } = { mode: "channel" };

  views.onChange((owner) => {
    if (owner === "channel") {
      view = { mode: "channel" };
      const current = client.state.currentChannel();
      if (current) renderChannelTimeline(current.channel.id);
      else api.ui.clearLog();
      refreshUi();
    } else if (!owner.startsWith("communities:")) {
      view = { mode: "external" };
    }
  });

  // Live-updatable UI handles — die with every clearLog repaint.
  let bubbleHandles = new Map<string, MessageHandle>();
  let summaryLineHandles = new Map<string, MessageHandle>();
  const draftBubbles = new Map<string, { handle: MessageHandle; rootId?: string }>();
  const draftersByRoot = new Map<string, Map<string, string>>();
  let watchThoughtBubble: MessageHandle | undefined;
  let watchTextBubble: MessageHandle | undefined;

  const panel = api.ui.createSidePanel({ width: 30, title: "channels", icon: "🗨️" });

  function resetHandles(): void {
    api.ui.clearLog();
    bubbleHandles = new Map();
    summaryLineHandles = new Map();
    draftBubbles.clear();
  }

  // ── Footer composition ──────────────────────────────────────────────────

  function reactionFooter(targetId: string): string {
    const reactions = client.reactions(targetId);
    if (!reactions || reactions.size === 0) return "";
    return [...reactions.entries()].map(([emoji, who]) => `${emoji} ${[...who].join(", ")}`).join("   ");
  }

  function threadMeta(channelId: string, rootId: string): string {
    const no = client.threadNo(rootId);
    const count = client.threadReplyCount(channelId, rootId);
    return DIM(`${count} repl${count === 1 ? "y" : "ies"} · `) + OSC8(`fez-thread://open/${no}`, DIM(`/thread ${no}`));
  }

  function messageMeta(channelId: string, msgId: string): string {
    const parts: string[] = [];
    if (client.msgById(msgId)?.edited) parts.push(DIM("edited"));
    if (client.isPinned(channelId, msgId)) parts.push(DIM("⚑ pinned"));
    if (client.threadReplyCount(channelId, msgId) > 0) parts.push(threadMeta(channelId, msgId));
    return parts.join(DIM("  ·  "));
  }

  // ── Renders ─────────────────────────────────────────────────────────────

  function paintBubble(msg: Msg): void {
    const handle = api.ui.appendMessage(msg.authorName, msg.content, msg.ts);
    handle.setFooter(reactionFooter(msg.id));
    bubbleHandles.set(msg.id, handle);
  }

  function threadBubble(msg: Msg): MessageHandle {
    const handle = api.ui.appendMessage(msg.authorName, msg.content, msg.ts);
    handle.setFooter(reactionFooter(msg.id));
    return handle;
  }

  function updateOrAppendSummaryLine(channelId: string, rootId: string): void {
    const root = bubbleHandles.get(rootId);
    if (root) {
      root.setMeta(messageMeta(channelId, rootId));
      return;
    }
    const text = DIM("└─ ") + threadMeta(channelId, rootId);
    const existing = summaryLineHandles.get(rootId);
    if (existing) existing.setContent(text);
    else summaryLineHandles.set(rootId, api.ui.appendMessage("", text, undefined, { bare: true }));
  }

  function renderChannelTimeline(channelId: string): void {
    resetHandles();
    const summarized = new Set<string>();
    for (const msg of client.messages(channelId)) {
      if (!msg.parentId) {
        paintBubble(msg);
        if (client.threadReplyCount(channelId, msg.id) > 0 || client.isPinned(channelId, msg.id) || msg.edited) {
          bubbleHandles.get(msg.id)?.setMeta(messageMeta(channelId, msg.id));
        }
        continue;
      }
      const rootId = msg.rootId!;
      if (summarized.has(rootId)) continue;
      summarized.add(rootId);
      updateOrAppendSummaryLine(channelId, rootId);
    }
  }

  function renderThreadView(channelId: string, rootId: string): void {
    resetHandles();
    const no = client.threadNo(rootId);
    const root = client.msgById(rootId);
    if (root) paintBubble(root);
    for (const msg of client.threadReplies(channelId, rootId)) bubbleHandles.set(msg.id, threadBubble(msg));
    api.ui.notify(`— in thread #${no}: plain messages reply here, /back returns to #channel —`);
  }

  function renderJobsView(): void {
    resetHandles();
    const byAgent = new Map<string, Job[]>();
    for (const job of client.jobs().values()) {
      const list = byAgent.get(job.agentPk) ?? [];
      list.push(job);
      byAgent.set(job.agentPk, list);
    }
    if (byAgent.size === 0 && client.workflowRuns().size === 0) {
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
    for (const [agentPk, list] of byAgent) {
      const lines = list
        .slice(-8)
        .map((j) => {
          const dur = j.endedAt ? age(j.endedAt - j.startedAt) : age(now - j.startedAt) + "…";
          return `${GLYPH[j.status]} "${j.snippet}" · ${dur}${j.currentTool ? ` · ⚙ ${j.currentTool}` : ""} · /thread ${client.threadNo(j.rootId)}`;
        })
        .join("\n");
      api.ui.appendMessage(`@${client.displayName(agentPk)}`, lines);
    }
    if (client.workflowRuns().size > 0) {
      const lines = [...client.workflowRuns().values()]
        .slice(-8)
        .map((r) => `${r.status === "done" ? "✓" : r.status === "failed" ? "✗" : "⚙"} ${r.workflow} — ${r.status}${r.step !== undefined ? ` (step ${r.step})` : ""}`)
        .join("\n");
      api.ui.appendMessage("workflows", lines);
    }
    api.ui.notify("— the job board assembles from wire events; /back returns —");
  }

  function refreshUi(): void {
    const busy = new Map<string, Job>();
    for (const job of client.activeJobs()) busy.set(job.agentPk, job);
    const statusLines = [...busy.values()]
      .slice(0, 5)
      .map((j) => ` ${j.status === "working" ? "⚙" : "👀"} @${client.displayName(j.agentPk)}${j.currentTool ? ` · ${j.currentTool}` : ""}`);
    panel.setText(
      client.state.sidebarText(client.unreadCounts()) +
        (statusLines.length > 0 ? `\n\n Working\n${statusLines.join("\n")}\n — /jobs` : "")
    );
    const current = client.state.currentChannel();
    // A foreign view (doc, DM) sets its own scope footer — leave it be.
    if (view.mode === "external") return;
    const suffix =
      view.mode === "thread"
        ? ` ▸ thread #${client.threadNo(view.rootId)}`
        : view.mode === "watch"
          ? ` ▸ watching @${view.agent}`
          : view.mode === "jobs"
            ? " ▸ jobs"
            : "";
    api.ui.setStatus("scope", current ? `${current.community.name}/#${current.channel.name}${suffix}` : "");
  }

  function renderTyping(): void {
    const currentRoot = view.mode === "thread" ? view.rootId : undefined;
    const who = client.typingWho(currentRoot).filter((n) => n !== "You");
    api.ui.setStatus(
      "typing",
      who.length === 0 ? "" : who.length === 1 ? `${who[0]} is typing…` : `${who.slice(0, 3).join(", ")} are typing…`
    );
  }

  function renderObserverStatus(): void {
    const parts = [...client.workingAgents().entries()].map(([name, w]) => `${name}: ${w.activity}`);
    api.ui.setStatus("observer", parts.length === 0 ? "" : `⚙ ${parts.slice(0, 3).join(" · ")}`);
  }
  setInterval(renderObserverStatus, 5000).unref?.();

  // Startup backfill lands as a burst of live:false messages — repaint
  // the scoped timeline once it settles instead of appending piecemeal.
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleTimelineRepaint(): void {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      const scope = client.state.scope;
      if (scope && view.mode === "channel") renderChannelTimeline(scope.channelId);
      refreshUi();
    }, 200);
  }

  // ── Client event wiring — the whole view reacts through these ─────────

  client.on("notice", (text) => api.ui.notify(text));
  client.on("typingChanged", renderTyping);
  client.on("unreadsChanged", refreshUi);
  client.on("channelsChanged", refreshUi);
  client.on("jobsChanged", () => {
    if (view.mode === "jobs") renderJobsView();
    refreshUi();
  });
  client.on("workflowRunsChanged", () => {
    if (view.mode === "jobs") renderJobsView();
  });

  client.on("message", (channelId, msg, ctx) => {
    if (!ctx.live) {
      if (client.state.scope?.channelId === channelId) scheduleTimelineRepaint();
      return;
    }
    const scope = client.state.scope;
    if (!scope || scope.channelId !== channelId) {
      refreshUi(); // badge bump
      return;
    }
    if (view.mode === "watch" || view.mode === "external") {
      api.ui.notify(`(in #channel: ${msg.authorName}: ${snippet(msg.content)})`);
      return;
    }
    if (view.mode === "jobs") return;
    if (view.mode === "thread") {
      if (msg.rootId === view.rootId) {
        const draft = draftBubbles.get(msg.authorPk);
        if (draft && draft.rootId === msg.rootId) {
          draft.handle.setContent(msg.content);
          draft.handle.setFooter(reactionFooter(msg.id));
          bubbleHandles.set(msg.id, draft.handle);
          draftBubbles.delete(msg.authorPk);
        } else {
          bubbleHandles.set(msg.id, threadBubble(msg));
        }
      } else {
        api.ui.notify(`(in #channel: ${msg.authorName}: ${snippet(msg.content)})`);
      }
      return;
    }
    if (!msg.parentId) {
      paintBubble(msg);
    } else {
      draftersByRoot.get(msg.rootId!)?.delete(msg.authorPk);
      updateOrAppendSummaryLine(channelId, msg.rootId!);
    }
  });

  client.on("messageEdited", (_channelId, msg) => {
    bubbleHandles.get(msg.id)?.setContent(msg.content);
  });

  client.on("metaChanged", (channelId, msgId) => {
    if (bubbleHandles.has(msgId)) {
      bubbleHandles.get(msgId)!.setMeta(messageMeta(channelId, msgId));
    } else if (view.mode === "channel" && client.state.scope?.channelId === channelId && client.threadReplyCount(channelId, msgId) > 0) {
      updateOrAppendSummaryLine(channelId, msgId);
    }
  });

  client.on("reaction", (_channelId, targetId) => {
    bubbleHandles.get(targetId)?.setFooter(reactionFooter(targetId));
  });

  client.on("draft", (channelId, authorPk, content, rootId) => {
    if (client.state.scope?.channelId !== channelId) return;
    if (view.mode === "thread" && rootId === view.rootId) {
      let draft = draftBubbles.get(authorPk);
      if (!draft) {
        const handle = api.ui.appendMessage(client.displayName(authorPk), content);
        handle.setFooter("✍ typing…");
        draft = { handle, rootId };
        draftBubbles.set(authorPk, draft);
      } else {
        draft.handle.setContent(content);
      }
      renderTyping();
    } else if (view.mode === "channel" && rootId) {
      const no = client.threadNo(rootId);
      let drafters = draftersByRoot.get(rootId);
      if (!drafters) draftersByRoot.set(rootId, (drafters = new Map()));
      drafters.set(authorPk, snippet(content, 60));
      const meta =
        DIM(
          drafters.size === 1
            ? `✍ ${client.displayName(authorPk)}: ${drafters.get(authorPk)} · `
            : `✍ ${[...drafters.keys()].map((pk) => client.displayName(pk)).join(", ")} are replying… · `
        ) + OSC8(`fez-thread://open/${no}`, DIM(`/thread ${no}`));
      const root = bubbleHandles.get(rootId);
      if (root) root.setMeta(meta);
      else {
        const existing = summaryLineHandles.get(rootId);
        if (existing) existing.setContent(DIM("└─ ") + meta);
        else summaryLineHandles.set(rootId, api.ui.appendMessage("", DIM("└─ ") + meta, undefined, { bare: true }));
      }
    }
  });

  client.on("observerFrame", (agent, frame) => {
    renderObserverStatus();
    // Inline tool activity on a streaming draft bubble.
    if (frame.type === "tool" && frame.title) {
      const pk = client.pkByName(agent);
      if (pk) draftBubbles.get(pk)?.handle.setFooter(`⚙ ${frame.title}`);
    }
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
      watchThoughtBubble = undefined;
      watchTextBubble = undefined;
    }
  });

  // ── URL handlers (clickable sidebar/footer links) ──────────────────────

  api.registerUrlHandler("fez-thread://open/", (url) => {
    const no = Number(url.slice("fez-thread://open/".length));
    const rootId = client.rootByThreadNo(no);
    const current = client.state.currentChannel();
    if (!rootId || !current) return;
    view = { mode: "thread", rootId };
    views.claim("communities:thread");
    renderThreadView(current.channel.id, rootId);
    refreshUi();
  });

  // ── Commands ────────────────────────────────────────────────────────────

  api.registerCommand("community", async (args, ctx) => {
    const [sub, ...rest] = args.trim().split(/\s+/);
    if (sub === "create") {
      const name = rest.join(" ").trim();
      if (!name) return ctx.reply("Usage: /community create <name>");
      const { communityId } = await client.createCommunity(name);
      refreshUi();
      ctx.reply(`Created **${name}** with #general — you're in it.\nCommunity id (share to invite): \`${communityId}\``);
      return;
    }
    if (sub === "join") {
      const id = rest[0];
      if (!id) return ctx.reply("Usage: /community join <community-id>");
      const found = await client.joinCommunity(id);
      refreshUi();
      if (!found) return ctx.reply(`Joined ${id}, but no community metadata found on this relay yet.`);
      const community = client.state.community(id)!;
      ctx.reply(`Joined **${community.name}**. Channels: ${[...community.channels.values()].map((c) => `#${c.name}`).join(", ") || "(none)"}\nNote: you can read, but others only see your messages once the creator /invites you.`);
      return;
    }
    if (sub === "list") {
      const list = await client.listCommunities();
      ctx.reply(
        list.length > 0
          ? list.map((c) => `• **${c.name}** — \`${c.id}\`${c.joined ? " (joined)" : ""}`).join("\n")
          : "No communities found on this relay."
      );
      return;
    }
    ctx.reply("Usage: /community create <name> | join <id> | list");
  });

  api.registerCommand("channels", async (_args, ctx) => {
    const lines: string[] = [];
    for (const id of client.state.joined) {
      const community = client.state.community(id);
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
    view = { mode: "channel" };
    views.claim("channel");
    const joined = await client.joinChannel(wanted);
    if (!joined) return ctx.reply(`No channel named "${wanted}" in your joined communities.`);
    refreshUi();
    ctx.reply(`Now in **#${joined.name}** — plain messages go to the channel. /leave to exit.`);
    renderChannelTimeline(joined.channelId);
  });

  api.registerCommand("leave", async (_args, ctx) => {
    if (!client.state.scope) return ctx.reply("Not in a channel.");
    client.leaveScope();
    view = { mode: "channel" };
    refreshUi();
    ctx.reply("Left the channel — back to normal fez chat.");
  });

  api.registerCommand("thread", async (args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join <channel> first.");
    const no = Number(args.trim());
    const rootId = client.rootByThreadNo(no);
    if (!rootId) return ctx.reply(`No thread #${args.trim() || "?"} — /threads lists them.`);
    view = { mode: "thread", rootId };
    views.claim("communities:thread");
    renderThreadView(current.channel.id, rootId);
    refreshUi();
  });

  api.registerCommand("threads", async (_args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join <channel> first.");
    const lines: string[] = [];
    for (const [no, rootId] of client.threadNumbers()) {
      const count = client.threadReplyCount(current.channel.id, rootId);
      if (count === 0) continue;
      const replies = client.threadReplies(current.channel.id, rootId);
      const root = client.msgById(rootId);
      const latest = replies.at(-1)?.authorName;
      lines.push(
        `• #${no} "${snippet(root?.content ?? "(not seen — indexer summary)")}" — ${count} repl${count === 1 ? "y" : "ies"}${latest ? `, latest from ${latest}` : ""}`
      );
    }
    ctx.reply(lines.length > 0 ? lines.join("\n") : "No threads in this channel yet — replies start them.");
  });

  api.registerCommand("back", async (_args, ctx) => {
    if (views.owner() === "channel") return ctx.reply("Not in a thread, watch, jobs, doc, or DM view.");
    watchThoughtBubble = undefined;
    watchTextBubble = undefined;
    // Releasing repaints the channel timeline via the onChange handler —
    // works no matter which extension owned the view.
    views.release();
  });

  api.registerCommand("watch", async (args, ctx) => {
    const agent = args.trim().replace(/^@/, "");
    if (!agent) return ctx.reply("Usage: /watch <agent-name> — live encrypted view of an agent you own. /back to leave.");
    view = { mode: "watch", agent };
    views.claim("communities:watch");
    watchThoughtBubble = undefined;
    watchTextBubble = undefined;
    resetHandles();
    api.ui.appendMessage("communities", `— watching **@${agent}** (owner-encrypted activity; frames arrive while it works) — /back to leave —`);
    for (const entry of client.observerFeed(agent).slice(-10)) {
      if (entry.type === "tool") api.ui.appendMessage("⚙", `${entry.title ?? "tool"}${entry.status ? ` — ${entry.status}` : ""}`);
      else if (entry.type === "turn") api.ui.notify(`— turn ${entry.status} —`);
    }
    refreshUi();
  });

  api.registerCommand("jobs", async (_args, _ctx) => {
    view = { mode: "jobs" };
    views.claim("communities:jobs");
    refreshUi();
    renderJobsView();
  });

  api.registerCommand("members", async (_args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join <channel> first.");
    const lines = [...current.channel.members.entries()].map(
      ([pubkey, role]) => `${presenceDot(pubkey)} ${client.displayName(pubkey)} (${role})${pubkey === client.pubkey ? " ← you" : ""}`
    );
    ctx.reply(lines.join("\n"));
  });

  api.registerCommand("invite", async (args, ctx) => {
    const [pubkey, role = "member"] = args.trim().split(/\s+/);
    if (!pubkey) return ctx.reply("Usage: /invite <pubkey> [member|admin|bot]");
    try {
      const name = await client.invite(pubkey, role as never);
      refreshUi();
      const current = client.state.currentChannel();
      ctx.reply(`Invited ${name} to #${current?.channel.name} as ${role}.`);
    } catch (err) {
      ctx.reply(err instanceof Error ? err.message : String(err));
    }
  });

  api.registerCommand("memory", async (args, ctx) => {
    const name = args.trim().replace(/^@/, "");
    if (!name) return ctx.reply("Usage: /memory <agent> — read that agent's persistent memory.");
    const agentPk = client.pkByName(name);
    if (!agentPk) return ctx.reply(`No agent named "${name}" seen on this relay.`);
    const events = await client.queryEngrams(agentPk);
    const byD = new Map<string, NostrEvent>();
    for (const event of events) {
      const d = event.tags.find((t) => t[0] === "d")?.[1];
      if (!d) continue;
      const prev = byD.get(d);
      if (!prev || event.created_at > prev.created_at || (event.created_at === prev.created_at && event.id < prev.id)) {
        byD.set(d, event as NostrEvent);
      }
    }
    let core: string | undefined;
    const entries: { slug: string; value: string }[] = [];
    for (const event of byD.values()) {
      try {
        const body = JSON.parse(client.decryptFrom(event.pubkey, event.content));
        if (body.slug === "core" && typeof body.profile === "string") core = body.profile;
        else if (typeof body.slug === "string" && typeof body.value === "string") entries.push(body);
      } catch { /* not ours / garbage */ }
    }
    if (!core && entries.length === 0) {
      return ctx.reply(`@${name} has no memory yet — it writes its own as it learns (or seed it: \`fez mem set --persona ${name} core "..."\`).`);
    }
    entries.sort((a, b) => a.slug.localeCompare(b.slug));
    ctx.reply([`**@${name} — memory**`, core ? `**core**\n${core}` : "_(core not set)_", ...entries.map((b) => `**${b.slug}**\n${b.value}`)].join("\n\n"));
  });

  function lastMessage(channelId: string, mine: boolean): Msg | undefined {
    const list = client.messages(channelId);
    return mine ? list.filter((m) => m.authorPk === client.pubkey).at(-1) : list.at(-1);
  }

  api.registerCommand("edit", async (args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const text = args.trim().replace(/\\n/g, "\n");
    if (!text) return ctx.reply("Usage: /edit <new text> — replaces your most recent message here.");
    const edited = await client.editLastOwnMessage(current.channel.id, current.community.id, text);
    if (!edited) return ctx.reply("No message of yours here to edit.");
    ctx.reply(`✏️ edited ("${snippet(text)}").`);
  });

  api.registerCommand("pin", async (_args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const target = lastMessage(current.channel.id, false);
    if (!target) return ctx.reply("Nothing here to pin.");
    if (client.isPinned(current.channel.id, target.id)) return ctx.reply("Already pinned.");
    await client.pinMessage(current.channel.id, current.community.id, target.id);
    ctx.reply(`⚑ pinned ${target.authorName}: "${snippet(target.content)}" — /pins lists them.`);
  });

  api.registerCommand("pins", async (_args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const pins = [...client.pins(current.channel.id).entries()];
    if (pins.length === 0) return ctx.reply("No pins in this channel — /pin pins the latest message.");
    ctx.reply(
      pins
        .map(([targetId, pin], i) => {
          const msg = client.msgById(targetId);
          return `${i + 1}. ${msg ? `${msg.authorName}: "${snippet(msg.content, 60)}"` : "(message not loaded)"} — pinned by ${pin.by === client.pubkey ? "you" : client.displayName(pin.by)}${pin.by === client.pubkey ? ` (/unpin ${i + 1})` : ""}`;
        })
        .join("\n")
    );
  });

  api.registerCommand("unpin", async (args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const pins = [...client.pins(current.channel.id).entries()];
    const pick = pins[Number(args.trim()) - 1];
    if (!pick) return ctx.reply("Usage: /unpin <number from /pins>");
    const [, pin] = pick;
    if (pin.by !== client.pubkey) return ctx.reply("Only the pinner can unpin.");
    await client.unpin(current.channel.id, current.community.id, pin.opId);
    ctx.reply("⚑ unpinned.");
  });

  api.registerCommand("bookmark", async (_args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const target = lastMessage(current.channel.id, false);
    if (!target) return ctx.reply("Nothing here to bookmark.");
    await client.bookmarkMessage(current.channel.id, current.community.id, target.id);
    ctx.reply(`🔖 bookmarked "${snippet(target.content)}" — /bookmarks lists yours.`);
  });

  api.registerCommand("bookmarks", async (_args, ctx) => {
    const bookmarks = client.myBookmarks();
    if (bookmarks.size === 0) return ctx.reply("No bookmarks — /bookmark saves the latest message in a channel.");
    ctx.reply(
      [...bookmarks.entries()]
        .sort((a, b) => b[1].ts - a[1].ts)
        .map(([targetId, bm]) => {
          const msg = client.msgById(targetId);
          const where = client.channelRef(bm.channelId)?.name;
          return `• ${msg ? `${msg.authorName}: "${snippet(msg.content, 60)}"` : "(message not loaded)"}${where ? ` — #${where}` : ""}`;
        })
        .join("\n")
    );
  });

  // ── Scheduled + reminders (intents; the sentinel executes) ─────────────

  function parseDelay(s: string): number | undefined {
    const m = s.match(/^(\d+)(s|m|h|d)$/);
    if (!m) return undefined;
    return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
  }
  function sentinelRunning(): boolean {
    try {
      const pid = Number(fs.readFileSync(path.join(os.homedir(), ".fez", "sentinel.pid"), "utf-8").trim());
      if (pid > 0) {
        process.kill(pid, 0);
        return true;
      }
    } catch { /* no pidfile or dead */ }
    return false;
  }
  const SENTINEL_WARNING = " — ⚠️ the sentinel executes these and it isn't running (`fez sentinel`)";

  api.registerCommand("schedule", async (args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const [delayRaw, ...rest] = args.trim().split(/\s+/);
    const delay = parseDelay(delayRaw ?? "");
    const text = rest.join(" ").replace(/\\n/g, "\n");
    if (!delay || !text) return ctx.reply("Usage: /schedule <30s|10m|2h|1d> <message>");
    const sendAt = Math.floor(Date.now() / 1000) + delay;
    await client.scheduleMessage(current.channel.id, current.community.id, sendAt, text);
    ctx.reply(`⏲ scheduled for ${new Date(sendAt * 1000).toLocaleTimeString()} in #${current.channel.name}${sentinelRunning() ? "" : SENTINEL_WARNING}`);
  });

  api.registerCommand("remind", async (args, ctx) => {
    const [delayRaw, ...rest] = args.trim().split(/\s+/);
    const delay = parseDelay(delayRaw ?? "");
    if (!delay) return ctx.reply("Usage: /remind <30s|10m|2h> [note] — with no note, the latest message here is the subject");
    const current = client.state.currentChannel();
    const target = current ? lastMessage(current.channel.id, false) : undefined;
    const note = rest.join(" ") || (target ? `${target.authorName}: ${snippet(target.content, 80)}` : "(reminder)");
    const remindAt = Math.floor(Date.now() / 1000) + delay;
    await client.setReminder(remindAt, note, target && !rest.length ? target.id : undefined);
    ctx.reply(`⏰ reminder at ${new Date(remindAt * 1000).toLocaleTimeString()}: "${snippet(note, 60)}"${sentinelRunning() ? "" : SENTINEL_WARNING}`);
  });

  // ── Chat input ─────────────────────────────────────────────────────────

  api.registerInputHandler(async (text) => {
    // Only handle input when WE own the view — a DM conversation's
    // input belongs to fez-dms.
    if (view.mode === "external") return false;
    const current = client.state.currentChannel();
    if (!current) return false;
    if (!current.channel.members.has(client.pubkey)) {
      api.ui.notify("⚠️  You're not in this channel's membership — other members won't see this until the creator /invites you.");
    }
    const mentions: string[] = [];
    for (const match of text.matchAll(/@([\w-]+)/g)) {
      const wanted = match[1].toLowerCase();
      for (const pubkey of current.channel.members.keys()) {
        if (client.displayName(pubkey).toLowerCase() === wanted) mentions.push(pubkey);
      }
    }
    const msg = await client.sendChannelMessage(text, {
      threadRootId: view.mode === "thread" ? view.rootId : undefined,
      mentionPks: mentions,
    });
    bubbleHandles.set(msg.id, view.mode === "thread" ? threadBubble(msg) : api.ui.appendMessage("You", text));
    return true;
  });

  // ── Scroll-up paging ────────────────────────────────────────────────────

  api.ui.onLogScrollTop(async () => {
    if (view.mode !== "channel") return;
    const current = client.state.currentChannel();
    if (!current || client.channelExhausted(current.channel.id)) return;
    const fresh = await client.loadOlderPage(current.channel.id, current.community.id);
    const summarized = new Set<string>();
    for (const msg of [...fresh].reverse()) {
      if (!msg.parentId) {
        const handle = api.ui.prependMessage(msg.authorName, msg.content, msg.ts);
        handle.setFooter(reactionFooter(msg.id));
        bubbleHandles.set(msg.id, handle);
        if (client.threadReplyCount(current.channel.id, msg.id) > 0) handle.setMeta(messageMeta(current.channel.id, msg.id));
        continue;
      }
      const rootId = msg.rootId!;
      if (bubbleHandles.has(rootId) && !summarized.has(rootId)) {
        summarized.add(rootId);
        bubbleHandles.get(rootId)!.setMeta(messageMeta(current.channel.id, rootId));
      } else if (!summarized.has(rootId) && !summaryLineHandles.has(rootId)) {
        summarized.add(rootId);
        summaryLineHandles.set(rootId, api.ui.prependMessage("", DIM("└─ ") + threadMeta(current.channel.id, rootId), undefined, { bare: true }));
      }
    }
    if (client.channelExhausted(current.channel.id)) {
      api.ui.prependMessage("", DIM(`— beginning of the channel — nothing older on the relay —`), undefined, { bare: true });
    }
  });

  // Initial paint.
  refreshUi();
}
