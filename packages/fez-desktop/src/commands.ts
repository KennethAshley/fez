import type { FezClient } from "@fez/client";
import type { BrowserWire } from "./wire";

/**
 * GUI slash commands — the TUI's muscle memory, desktop-shaped. Typing
 * "/" in the composer pops typed hints (Discord's pattern, Buzz's
 * too); Enter runs the command instead of sending a message. Every
 * command maps onto a client method or a surface the GUI already has —
 * this file is routing, not new capability.
 */

export interface CommandCtx {
  client: FezClient;
  wire: BrowserWire;
  channelId?: string;
  communityId?: string;
  ui: {
    openSearch: (query: string) => void;
    watch: (agent: string) => void;
    openDocs: () => void;
    openAgents: () => void;
    openDm: (convoKey: string) => void;
    goHome: () => void;
    goPulse: () => void;
    toggleMute: (channelId: string) => void;
  };
}

export interface CommandMeta {
  name: string;
  args: string;
  description: string;
}

export const COMMANDS: CommandMeta[] = [
  { name: "help", args: "", description: "list commands" },
  { name: "search", args: "<words>", description: "search messages + docs (⌘K)" },
  { name: "dm", args: "<name>", description: "open a direct message" },
  { name: "watch", args: "<agent>", description: "live activity window" },
  { name: "doc", args: "", description: "this channel's doc" },
  { name: "agents", args: "", description: "agents pane" },
  { name: "pulse", args: "", description: "all-agents dashboard" },
  { name: "home", args: "", description: "your mentions inbox" },
  { name: "join", args: "<channel>", description: "hop to a channel by name" },
  { name: "mute", args: "", description: "mute/unmute this channel" },
  { name: "status", args: "[text]", description: "set your status — empty clears" },
  { name: "name", args: "<text>", description: "set your display name" },
  { name: "remind", args: "<30s|10m|2h> [note]", description: "encrypted reminder" },
  { name: "schedule", args: "<10m|2h> <text>", description: "send a message later" },
  { name: "invite", args: "<name|pubkey> [role]", description: "invite here (creator)" },
  { name: "kick", args: "<name>", description: "remove from channel (creator)" },
  { name: "ban", args: "<name>", description: "ban from community (creator)" },
  { name: "unban", args: "<name>", description: "lift a ban (creator)" },
];

function parseDelay(token: string | undefined): number | undefined {
  const match = /^(\d+)(s|m|h|d)$/.exec(token ?? "");
  if (!match) return undefined;
  const units = { s: 1, m: 60, h: 3600, d: 86400 } as const;
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

function resolvePk(client: FezClient, raw: string): string | undefined {
  const trimmed = raw.replace(/^@/, "");
  return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : client.pkByName(trimmed);
}

/** Returns feedback text for the composer notice ("" = silent success). */
export async function runCommand(text: string, ctx: CommandCtx): Promise<string> {
  const [cmd = "", ...rest] = text.slice(1).trim().split(/\s+/);
  const argText = rest.join(" ");
  const { client, ui } = ctx;
  try {
    switch (cmd.toLowerCase()) {
      case "help":
        return COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""}`).join("  ·  ");
      case "search":
        if (!argText) return "usage: /search <words>";
        ui.openSearch(argText);
        return "";
      case "dm": {
        const pk = resolvePk(client, rest[0] ?? "");
        if (!pk) return `nobody named "${rest[0] ?? ""}" — try a known name or a 64-hex pubkey`;
        ui.openDm(pk);
        return "";
      }
      case "watch": {
        const name = (rest[0] ?? "").replace(/^@/, "");
        if (!name) return "usage: /watch <agent>";
        ui.watch(name);
        return "";
      }
      case "doc":
        if (!ctx.channelId) return "no channel scope";
        ui.openDocs();
        return "";
      case "agents":
        ui.openAgents();
        return "";
      case "pulse":
        ui.goPulse();
        return "";
      case "home":
        ui.goHome();
        return "";
      case "join": {
        if (!rest[0]) return "usage: /join <channel name>";
        const joined = await client.joinChannel(rest[0].replace(/^#/, ""));
        return joined ? `→ #${joined.name}` : `no channel named "${rest[0]}" in your communities`;
      }
      case "mute":
        if (!ctx.channelId) return "no channel scope";
        ui.toggleMute(ctx.channelId);
        return "";
      case "status":
        await client.setStatus(argText);
        return argText ? `status set: ${argText}` : "status cleared";
      case "name":
        if (!argText) return "usage: /name <display name>";
        await client.setProfile(argText);
        return `you now appear as ${argText}`;
      case "remind": {
        const delay = parseDelay(rest[0]);
        if (!delay) return "usage: /remind <30s|10m|2h|1d> [note]";
        const note = rest.slice(1).join(" ") || "(reminder)";
        await client.setReminder(Math.floor(Date.now() / 1000) + delay, note);
        return `◷ reminder at ${new Date(Date.now() + delay * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${note}`;
      }
      case "schedule": {
        if (!ctx.channelId || !ctx.communityId) return "no channel scope";
        const delay = parseDelay(rest[0]);
        const body = rest.slice(1).join(" ");
        if (!delay || !body) return "usage: /schedule <10m|2h> <message>";
        await client.scheduleMessage(ctx.channelId, ctx.communityId, Math.floor(Date.now() / 1000) + delay, body);
        return `⏲ scheduled for ${new Date(Date.now() + delay * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — the sentinel sends it`;
      }
      case "invite": {
        const pk = resolvePk(client, rest[0] ?? "");
        if (!pk) return `nobody named "${rest[0] ?? ""}"`;
        const role = rest[1] === "bot" ? "bot" : "member";
        const name = await client.invite(pk, role as never);
        return `✓ invited ${name} as ${role}`;
      }
      case "kick": {
        const pk = resolvePk(client, rest[0] ?? "");
        if (!pk) return `nobody named "${rest[0] ?? ""}"`;
        return `✓ removed ${await client.kick(pk)}`;
      }
      case "ban": {
        if (!ctx.communityId) return "no channel scope";
        const pk = resolvePk(client, rest[0] ?? "");
        if (!pk) return `nobody named "${rest[0] ?? ""}"`;
        return `✓ banned ${await client.banUser(ctx.communityId, pk)}`;
      }
      case "unban": {
        if (!ctx.communityId) return "no channel scope";
        const pk = resolvePk(client, rest[0] ?? "");
        if (!pk) return `nobody named "${rest[0] ?? ""}"`;
        return `✓ unbanned ${await client.unbanUser(ctx.communityId, pk)}`;
      }
      default:
        return `unknown command /${cmd} — /help lists them`;
    }
  } catch (err) {
    return `✗ ${err instanceof Error ? err.message : String(err)}`;
  }
}
