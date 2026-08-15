import crypto from "node:crypto";
import { CommunityState, type Role } from "./state.js";
import type { FezExtensionAPI, NostrEvent, NostrFilter } from "./api-types.js";

const KIND_AGENT_METADATA = 47000;
const KIND_COMMUNITY = 47100;
const KIND_CHANNEL = 47101;
const KIND_MEMBERSHIP = 47102;
const KIND_CHANNEL_MESSAGE = 47103;
const KIND_TYPING = 20002; // ephemeral, Buzz's kind — see fez src/kinds.ts

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
  }
  const MSG_CACHE_CAP = 200;
  const messagesByChannel = new Map<string, Msg[]>();
  const msgById = new Map<string, Msg>();
  // Threads get small user-facing numbers (#1, #2, …) as they're first seen —
  // event-id hex is unusable as a command argument.
  const threadNoByRoot = new Map<string, number>();
  const rootByThreadNo = new Map<number, string>();
  let nextThreadNo = 1;

  let view: { mode: "channel" } | { mode: "thread"; rootId: string } = { mode: "channel" };

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

  /** Visible indent depth by walking the parent chain (Buzz caps visible depth; TUI caps at 3). */
  function depthOf(msg: Msg): number {
    let depth = 0;
    let current: Msg | undefined = msg;
    while (current?.parentId && depth < 3) {
      depth++;
      current = msgById.get(current.parentId);
    }
    return depth;
  }

  function snippet(text: string, max = 40): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  }

  // pubkey -> expiry timestamp for active typing indicators in the current
  // scope. Rendered as a footer segment; pruned on a 1s tick (Buzz's model:
  // TTL from last heartbeat, cleared instantly when a real message lands).
  const typing = new Map<string, number>();
  function renderTyping(): void {
    const now = Date.now();
    for (const [pk, expiry] of typing) if (expiry <= now) typing.delete(pk);
    const who = [...typing.keys()].map(displayName);
    api.ui.setStatus(
      "typing",
      who.length === 0 ? "" : who.length === 1 ? `${who[0]} is typing…` : `${who.slice(0, 3).join(", ")} are typing…`
    );
  }
  setInterval(renderTyping, 1000).unref?.();

  const panel = api.ui.createSidePanel({ width: 26 });

  function displayName(pubkey: string): string {
    return names.get(pubkey) ?? `${pubkey.slice(0, 8)}…`;
  }

  function refreshUi(): void {
    panel.setText(state.sidebarText());
    const current = state.currentChannel();
    const threadSuffix =
      view.mode === "thread" ? ` ▸ thread #${threadNo(view.rootId)}` : "";
    api.ui.setStatus(
      "scope",
      current ? `${current.community.name}/#${current.channel.name}${threadSuffix}` : ""
    );
  }

  /** Bubble for a thread reply — indented author label, Buzz's connector glyph. */
  function threadBubble(msg: Msg): void {
    const indent = "  ".repeat(Math.max(0, depthOf(msg) - 1));
    api.ui.appendMessage(`${indent}↳ ${msg.authorName}`, msg.content);
  }

  /** Repaint the channel timeline from cache: root bubbles, threads as one summary line each. */
  function renderChannelTimeline(channelId: string): void {
    api.ui.clearLog();
    const list = messagesByChannel.get(channelId) ?? [];
    const summarized = new Set<string>();
    for (const msg of list) {
      if (!msg.parentId) {
        api.ui.appendMessage(msg.authorName === "You" ? "You" : msg.authorName, msg.content);
        continue;
      }
      const rootId = msg.rootId!;
      if (summarized.has(rootId)) continue;
      summarized.add(rootId);
      const replies = threadReplies(channelId, rootId);
      const root = msgById.get(rootId);
      const no = threadNo(rootId);
      api.ui.appendMessage(
        `thread #${no}`,
        `${replies.length} repl${replies.length === 1 ? "y" : "ies"} to "${snippet(root?.content ?? "…")}" — /thread ${no}`
      );
    }
  }

  /** Repaint as a single thread: root bubble, replies in arrival order, indented. */
  function renderThreadView(channelId: string, rootId: string): void {
    api.ui.clearLog();
    const no = threadNo(rootId);
    const root = msgById.get(rootId);
    if (root) api.ui.appendMessage(root.authorName, root.content);
    for (const msg of threadReplies(channelId, rootId)) threadBubble(msg);
    api.ui.appendMessage("communities", `— in thread #${no}: plain messages reply here, /back returns to #channel —`);
  }

  function absorb(event: NostrEvent): void {
    if (state.absorb(event)) refreshUi();
  }

  function handleIncomingMessage(event: NostrEvent): void {
    if (seenMessages.has(event.id)) return;
    seenMessages.add(event.id);
    // A real message from someone clears their typing indicator immediately
    // (Buzz does the same rather than waiting out the TTL).
    typing.delete(event.pubkey);
    renderTyping();
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId) return;
    if (!state.isMember(communityId, channelId, event.pubkey)) return; // client-side gate

    const msg = cacheMessage(channelId, event, event.pubkey === nostr!.pubkey ? "You" : displayName(event.pubkey));
    if (event.pubkey === nostr!.pubkey) return; // own message, already echoed on send

    const scope = state.scope;
    if (!scope || scope.channelId !== channelId || scope.communityId !== communityId) return;

    // Buzz's timeline rule, TUI-shaped: the main view shows roots as
    // bubbles and collapses replies into thread summaries; the thread view
    // shows its own replies as indented bubbles and everything else as a
    // compact line so the thread stays coherent.
    if (view.mode === "thread") {
      if (msg.rootId === view.rootId) {
        threadBubble(msg);
      } else {
        api.ui.appendMessage("communities", `(in #channel: ${msg.authorName}: ${snippet(msg.content)})`);
      }
      return;
    }
    if (!msg.parentId) {
      api.ui.appendMessage(msg.authorName, msg.content);
    } else {
      const no = threadNo(msg.rootId!);
      const count = threadReplies(channelId, msg.rootId!).length;
      api.ui.appendMessage(
        `thread #${no}`,
        `↳ ${msg.authorName}: ${snippet(msg.content)} (${count} repl${count === 1 ? "y" : "ies"}) — /thread ${no}`
      );
    }
  }

  function handleTyping(event: NostrEvent): void {
    if (event.pubkey === nostr!.pubkey) return;
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId || state.scope?.channelId !== channelId) return;
    typing.set(event.pubkey, Date.now() + TYPING_TTL_MS);
    renderTyping();
  }

  function resubscribe(): void {
    unsubscribe?.();
    const ids = [...state.joined];
    const filters: NostrFilter[] = [
      { kinds: [KIND_AGENT_METADATA], since: Math.floor(Date.now() / 1000) - 7 * 86400 },
    ];
    if (ids.length > 0) {
      filters.push(
        { kinds: [KIND_COMMUNITY, KIND_CHANNEL, KIND_MEMBERSHIP], "#c": ids },
        { kinds: [KIND_COMMUNITY], "#d": ids },
        { kinds: [KIND_CHANNEL_MESSAGE, KIND_TYPING], "#h": channelIdsOfJoined(), since: Math.floor(Date.now() / 1000) }
      );
    }
    unsubscribe = nostr!.subscribe(filters, (event) => {
      if (event.kind === KIND_TYPING) {
        handleTyping(event);
        return;
      }
      if (event.kind === KIND_AGENT_METADATA) {
        try {
          const name = JSON.parse(event.content).name;
          if (name) names.set(event.pubkey, name);
        } catch { /* ignore */ }
        return;
      }
      if (event.kind === KIND_CHANNEL_MESSAGE) {
        handleIncomingMessage(event);
        return;
      }
      absorb(event);
      // Membership/channel changes can add channels — refresh the live
      // message subscription so new channels stream immediately.
      if (event.kind === KIND_CHANNEL) resubscribe();
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
        state.save();
        refreshUi();
        ctx.reply(`Now in **#${channel.name}** — plain messages go to the channel. /leave to exit.`);
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
      const replies = threadReplies(current.channel.id, rootId);
      if (replies.length === 0) continue;
      const root = msgById.get(rootId);
      lines.push(`• #${no} "${snippet(root?.content ?? "…")}" — ${replies.length} repl${replies.length === 1 ? "y" : "ies"}, latest from ${replies.at(-1)!.authorName}`);
    }
    ctx.reply(lines.length > 0 ? lines.join("\n") : "No threads in this channel yet — replies start them.");
  });

  api.registerCommand("back", async (_args, ctx) => {
    if (view.mode !== "thread") return ctx.reply("Not in a thread view.");
    const current = state.currentChannel();
    view = { mode: "channel" };
    if (current) renderChannelTimeline(current.channel.id);
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
    const current = state.currentChannel();
    if (!current) return false;

    if (!current.channel.members.has(nostr.pubkey)) {
      api.ui.appendMessage("communities", "⚠️  You're not in this channel's membership — other members won't see this until the creator /invites you.");
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
    if (view.mode === "thread") {
      threadBubble(msg);
    } else {
      api.ui.appendMessage("You", text);
    }
    return true;
  });

  // ── Startup ──────────────────────────────────────────────────────────────

  void (async () => {
    const metadataEvents = await nostr.query([{ kinds: [KIND_AGENT_METADATA], limit: 200 }]);
    for (const event of metadataEvents) {
      try {
        const name = JSON.parse(event.content).name;
        if (name) names.set(event.pubkey, name);
      } catch { /* ignore */ }
    }
    await syncJoined();
    resubscribe();
    refreshUi();
  })();
}

