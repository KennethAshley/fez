import crypto from "node:crypto";
import { CommunityState, type Role } from "./state.js";
import type { FezExtensionAPI, NostrEvent, NostrFilter } from "./api-types.js";

const KIND_AGENT_METADATA = 47000;
const KIND_COMMUNITY = 47100;
const KIND_CHANNEL = 47101;
const KIND_MEMBERSHIP = 47102;
const KIND_CHANNEL_MESSAGE = 47103;

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

  const panel = api.ui.createSidePanel({ width: 26 });

  function displayName(pubkey: string): string {
    return names.get(pubkey) ?? `${pubkey.slice(0, 8)}…`;
  }

  function refreshUi(): void {
    panel.setText(state.sidebarText());
    const current = state.currentChannel();
    api.ui.setStatus(
      "scope",
      current ? `${current.community.name}/#${current.channel.name}` : ""
    );
  }

  function absorb(event: NostrEvent): void {
    if (state.absorb(event)) refreshUi();
  }

  function handleIncomingMessage(event: NostrEvent): void {
    if (seenMessages.has(event.id)) return;
    seenMessages.add(event.id);
    if (event.pubkey === nostr!.pubkey) return; // own message, already echoed
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId) return;
    const scope = state.scope;
    if (!scope || scope.channelId !== channelId || scope.communityId !== communityId) return;
    if (!state.isMember(communityId, channelId, event.pubkey)) return; // client-side gate
    api.ui.appendMessage(displayName(event.pubkey), event.content);
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
        { kinds: [KIND_CHANNEL_MESSAGE], "#h": channelIdsOfJoined(), since: Math.floor(Date.now() / 1000) }
      );
    }
    unsubscribe = nostr!.subscribe(filters, (event) => {
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
    state.save();
    refreshUi();
    ctx.reply("Left the channel — back to normal fez chat.");
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

    api.ui.appendMessage("You", text);

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

    const event = await nostr.publish({
      kind: KIND_CHANNEL_MESSAGE,
      tags: [
        ["h", current.channel.id],
        ["c", current.community.id],
        ...mentions.map((pk) => ["p", pk]),
      ],
      content: text,
    });
    seenMessages.add(event.id);
    void mentions; // p tags carry them; standing agents react over the relay
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

