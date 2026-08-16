import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FezExtensionAPI } from "./api-types.js";

/**
 * fez-herdr — register fez personas as herdr-managed tabs and pin a
 * clickable herdr section in the sidebar. herdr (the user's terminal
 * workspace manager for AI agents) exposes a newline-delimited JSON
 * socket API at ~/.config/herdr/herdr.sock; this extension speaks it
 * directly over node:net — no CLI dependency, nothing to bundle.
 *
 * /herdr register <persona> <channel> [respondTo]  — create a labeled
 *   herdr tab, type the channel-agent run command into its shell
 *   (pane.send_text), and track it: herdr now supervises the agent,
 *   which survives fez restarts and is attachable in the herdr session.
 * /herdr list | focus <persona> | status
 *
 * The sidebar section lists registered tabs with live status glyphs;
 * each entry is an OSC-8 hyperlink (fez-herdr://focus/<tabId>) — a
 * mouse click jumps the herdr session to that agent's terminal, via
 * the registerUrlHandler primitive.
 */

const SOCKET = path.join(os.homedir(), ".config", "herdr", "herdr.sock");
const REGISTRY = path.join(os.homedir(), ".fez", "herdr-tabs.json");

interface HerdrResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** One request per connection — simple and reconnect-free for a low-rate control surface. */
function herdrCall(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET);
    let buf = "";
    const id = Math.random().toString(36).slice(2);
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const newline = buf.indexOf("\n");
      if (newline === -1) return;
      sock.end();
      try {
        const msg: HerdrResponse = JSON.parse(buf.slice(0, newline));
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result ?? {});
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    sock.on("connect", () => sock.write(JSON.stringify({ id, method, params }) + "\n"));
    setTimeout(() => {
      sock.destroy();
      reject(new Error("herdr socket timeout"));
    }, 5000).unref?.();
  });
}

interface RegisteredTab {
  persona: string;
  /** Channel specs (names or ids) this agent's process serves — grows as summons pull it into new channels. */
  channels: string[];
  tabId: string;
  paneId: string;
}

function loadRegistry(): RegisteredTab[] {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, "utf-8")) as (RegisteredTab & { channel?: string })[];
    // Migrate pre-multi-channel entries ({channel: "x"} -> {channels: ["x"]}).
    return raw.map((t) => ({ ...t, channels: t.channels ?? (t.channel ? [t.channel] : []) }));
  } catch {
    return [];
  }
}

function saveRegistry(tabs: RegisteredTab[]): void {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(tabs, null, 2), "utf-8");
}

const OSC8 = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

export default function herdr(api: FezExtensionAPI): void {
  let registered = loadRegistry();
  const panel = api.ui.createSidePanel();
  let liveTabIds = new Set<string>();

  async function refreshPanel(): Promise<void> {
    try {
      const result = await herdrCall("tab.list", {});
      const tabs = (result.tabs as { tab_id: string }[]) ?? [];
      liveTabIds = new Set(tabs.map((t) => t.tab_id));
    } catch {
      liveTabIds = new Set(); // herdr down — everything shows ○
    }
    const lines = [bold("Agents")];
    if (registered.length === 0) {
      lines.push(dim("@mention a persona to summon it"));
    }
    // Agent-centric: the entry IS the agent (click → its terminal), not a
    // channel binding — mentions can pull an agent into any channel, so a
    // single-channel label would lie. One channel shows by name; more
    // collapse to a count.
    for (const tab of registered) {
      const alive = liveTabIds.has(tab.tabId);
      const glyph = alive ? "\x1b[32m●\x1b[39m" : dim("○");
      const where =
        tab.channels.length === 1 ? dim("#" + tab.channels[0].slice(0, 12)) : dim(`·${tab.channels.length}ch`);
      lines.push(`${glyph} ${OSC8(`fez-herdr://focus/${tab.tabId}`, `@${tab.persona}`)} ${where}`);
    }
    panel.setText("\n" + lines.join("\n"));
  }

  api.registerUrlHandler("fez-herdr://focus/", (url) => {
    const tabId = url.slice("fez-herdr://focus/".length);
    void herdrCall("tab.focus", { tab_id: tabId }).catch(() => {});
  });

  function agentCommand(persona: string, channels: string[], respondTo: string): string {
    const relay = process.env.FEZ_RELAY ?? "wss://relay.damus.io";
    // FEZ_AGENT_OWNER = the registering user: enables the encrypted
    // observer stream (/watch <persona>) for free on registered agents.
    return `FEZ_AGENT_PERSONA=${persona} FEZ_AGENT_CHANNELS=${channels.join(",")} FEZ_AGENT_RESPOND_TO=${respondTo} FEZ_AGENT_OWNER=${api.nostr!.pubkey} FEZ_RELAY=${relay} fez run ${process.cwd()}/packages/fez-communities/dist/channel-agent.js\n`;
  }

  /** Create the herdr tab and type the run command — shared by /herdr register and auto-spawn. */
  async function registerAgent(persona: string, channels: string[], respondTo: string): Promise<RegisteredTab> {
    const created = await herdrCall("tab.create", {
      label: `fez:${persona}`,
      cwd: process.cwd(),
      focus: false,
    });
    const tab = created.tab as { tab_id: string };
    const pane = created.root_pane as { pane_id: string };
    await herdrCall("pane.send_text", { pane_id: pane.pane_id, text: agentCommand(persona, channels, respondTo) });
    const entry: RegisteredTab = { persona, channels, tabId: tab.tab_id, paneId: pane.pane_id };
    registered = registered.filter((t) => t.persona !== persona);
    registered.push(entry);
    saveRegistry(registered);
    await refreshPanel();
    return entry;
  }

  /**
   * A summon into a channel the agent doesn't serve: restart its EXISTING
   * pane with the union of channels — one process per persona, not one
   * per channel.
   */
  async function expandAgentChannels(entry: RegisteredTab, channel: string): Promise<void> {
    entry.channels.push(channel);
    saveRegistry(registered);
    await herdrCall("pane.send_keys", { pane_id: entry.paneId, keys: ["ctrl+c"] });
    await new Promise((r) => setTimeout(r, 800));
    await herdrCall("pane.send_text", { pane_id: entry.paneId, text: agentCommand(entry.persona, entry.channels, "owner") });
    await refreshPanel();
  }

  // ── Auto-spawn: @mentioning a persona that isn't running summons it.
  // Watch the user's OWN channel messages for @names that match a persona
  // file (~/.fez/personas/<name>.md) with no live herdr tab; spawn it into
  // the mentioned channel, then invite its pubkey (as the community
  // creator) the moment its 47000 metadata announcement appears. The
  // freshly spawned agent backfills the summoning mention itself
  // (channel-agent's name-mention + backfill logic). ────────────────────
  const KIND_AGENT_METADATA = 47000;
  const KIND_AGENT_ATTESTATION = 47006;
  const KIND_CHANNEL_MESSAGE = 47103;
  const KIND_MEMBERSHIP = 47102;
  const spawning = new Set<string>();
  const pendingInvites = new Map<string, { channelId: string; communityId: string }>(); // persona -> where to invite
  const attested = new Set<string>(); // agent pubkeys attested this session

  /**
   * Owner attestation (47006): the registering user signs "this pubkey is
   * my agent", making the agent a verifiable SIBLING — other agents with
   * respondTo=owner admit it, so the user's fleet chains freely while
   * strangers stay locked out (Buzz's NIP-OA posture).
   */
  function attestAgent(agentPubkey: string): void {
    if (attested.has(agentPubkey)) return;
    attested.add(agentPubkey);
    void api
      .nostr!.publish({ kind: KIND_AGENT_ATTESTATION, tags: [["p", agentPubkey]], content: "" })
      .catch(() => attested.delete(agentPubkey));
  }

  function personaExists(name: string): boolean {
    try {
      fs.accessSync(path.join(os.homedir(), ".fez", "personas", `${name}.md`));
      return true;
    } catch {
      return false;
    }
  }

  async function inviteToChannel(agentPubkey: string, channelId: string, communityId: string): Promise<void> {
    const memberships = await api.nostr!.query([{ kinds: [KIND_MEMBERSHIP], "#d": [channelId] }]);
    const latest = memberships.sort((a, b) => a.created_at - b.created_at).at(-1);
    const ptags = latest?.tags.filter((t) => t[0] === "p") ?? [];
    if (ptags.some((t) => t[1] === agentPubkey)) return; // already a member
    ptags.push(["p", agentPubkey, "bot"]);
    await api.nostr!.publish({
      kind: KIND_MEMBERSHIP,
      tags: [["d", channelId], ["c", communityId], ...ptags],
      content: "",
    });
  }

  if (api.nostr) {
    const nostr = api.nostr;
    // Own outgoing messages → summon mentioned-but-absent personas.
    nostr.subscribe(
      [{ kinds: [KIND_CHANNEL_MESSAGE], authors: [nostr.pubkey], since: Math.floor(Date.now() / 1000) }],
      (event) => {
        const channelId = event.tags.find((t) => t[0] === "h")?.[1];
        const communityId = event.tags.find((t) => t[0] === "c")?.[1];
        if (!channelId || !communityId) return;
        for (const match of event.content.matchAll(/@([\w-]+)/g)) {
          const persona = match[1].toLowerCase();
          if (spawning.has(persona) || !personaExists(persona)) continue;
          const existing = registered.find((t) => t.persona === persona);
          if (existing && liveTabIds.has(existing.tabId)) {
            // Running, but summoned into a channel it doesn't serve:
            // restart its pane with the union — one process per persona.
            if (!existing.channels.includes(channelId)) {
              spawning.add(persona);
              pendingInvites.set(persona, { channelId, communityId });
              api.ui.appendMessage("herdr", `pulling **@${persona}** into this channel…`);
              expandAgentChannels(existing, channelId)
                .catch((err) => {
                  spawning.delete(persona);
                  api.ui.appendMessage("herdr", `⚠️ couldn't expand @${persona}: ${err instanceof Error ? err.message : err}`);
                });
            }
            continue;
          }
          spawning.add(persona);
          pendingInvites.set(persona, { channelId, communityId });
          api.ui.appendMessage("herdr", `summoning **@${persona}** — spawning it in a herdr tab…`);
          // respondTo=owner (Buzz's default posture): the summoner and
          // attested sibling agents can trigger it; strangers can't.
          registerAgent(persona, [channelId], "owner")
            .catch((err) => {
              spawning.delete(persona);
              api.ui.appendMessage("herdr", `⚠️ couldn't spawn @${persona}: ${err instanceof Error ? err.message : err}`);
            });
        }
      }
    );
    // Agent metadata announcements → complete pending invites.
    nostr.subscribe(
      [{ kinds: [KIND_AGENT_METADATA], since: Math.floor(Date.now() / 1000) }],
      (event) => {
        let name: string | undefined;
        try {
          name = JSON.parse(event.content).name?.toLowerCase();
        } catch {
          return;
        }
        if (!name) return;
        // Any of our registered agents announcing itself gets an owner
        // attestation — makes it a verifiable sibling to the rest of the
        // fleet, regardless of how it was started.
        if (registered.some((t) => t.persona === name)) attestAgent(event.pubkey);
        if (!pendingInvites.has(name)) return;
        const target = pendingInvites.get(name)!;
        pendingInvites.delete(name);
        spawning.delete(name);
        inviteToChannel(event.pubkey, target.channelId, target.communityId)
          .then(() => api.ui.appendMessage("herdr", `**@${name}** is up and invited — it'll answer your mention momentarily.`))
          .catch(() => api.ui.appendMessage("herdr", `⚠️ @${name} spawned but the invite failed — /invite ${event.pubkey} bot`));
      }
    );
  }

  api.registerCommand("herdr", async (args, ctx) => {
    const [sub, ...rest] = args.trim().split(/\s+/);

    if (sub === "status") {
      try {
        const pong = await herdrCall("ping", {});
        ctx.reply(`herdr ${pong.version} — protocol ${pong.protocol}, ${registered.length} fez agent(s) registered.`);
      } catch (err) {
        ctx.reply(`herdr unreachable: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (sub === "register") {
      const [persona, channel, respondTo = "anyone"] = rest;
      if (!persona || !channel) return ctx.reply("Usage: /herdr register <persona> <channel> [respondTo]");
      try {
        const entry = await registerAgent(persona, [channel], respondTo);
        ctx.reply(`Registered **@${persona}** with herdr — tab \`${entry.tabId}\` serving #${channel}. Click it in the sidebar to jump to its terminal.`);
      } catch (err) {
        ctx.reply(`herdr registration failed: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (sub === "focus") {
      const persona = rest[0];
      const tab = registered.find((t) => t.persona === persona);
      if (!tab) return ctx.reply(`No registered agent "@${persona}" — /herdr list`);
      await herdrCall("tab.focus", { tab_id: tab.tabId }).catch((err) => ctx.reply(`focus failed: ${err.message}`));
      return;
    }

    if (sub === "list") {
      if (registered.length === 0) return ctx.reply("No fez agents registered with herdr.");
      ctx.reply(
        registered
          .map((t) => `• @${t.persona} → ${t.channels.map((c) => "#" + c).join(", ")} — tab \`${t.tabId}\` ${liveTabIds.has(t.tabId) ? "(running)" : "(gone)"}`)
          .join("\n")
      );
      return;
    }

    ctx.reply("Usage: /herdr status | register <persona> <channel> [respondTo] | focus <persona> | list");
  });

  void refreshPanel();
  setInterval(() => void refreshPanel(), 15000).unref?.();
}
