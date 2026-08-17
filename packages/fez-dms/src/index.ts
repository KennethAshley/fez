import type { FezExtensionAPI } from "./api-types.js";
import type { FezClient } from "@fez/client";

/**
 * fez-dms — the private-DM view, a standalone installable extension over
 * @fez/client (which owns DM conversations, unwrap, unread counts, and
 * presence). This file renders: the DMS sidebar box with presence dots
 * and unread counts, the /dm conversation view, and the input routing
 * that sends plain text over the encrypted pipe while a conversation is
 * open. Split out of fez-communities via api.client + the view bus.
 */
export default function dms(api: FezExtensionAPI): void {
  if (!api.client) return;
  const client = api.client as FezClient;
  const views = api.ui.viewBus;

  const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
  const OSC8 = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
  const presenceDot = (pk: string) => (client.isOnline(pk) ? "\x1b[32m●\x1b[39m" : DIM("○"));
  const snippet = (s: string, n = 40) => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n)}…` : one;
  };

  // Convo keys are "+"-joined pubkey sets for groups, bare pk for 1:1.
  const isGroup = (key: string) => key.includes("+");
  const titleOf = (key: string) =>
    key.split("+").map((pk) => client.displayName(pk)).join(" + ");
  const groupDot = (key: string) =>
    key.split("+").every((pk) => client.isOnline(pk)) ? "\x1b[32m●\x1b[39m" : DIM("○");

  const dmPanel = api.ui.createSidePanel({ title: "dms", icon: "✉️", order: 30 });
  const OWNER_PREFIX = "dm:";
  const viewingPeer = () => (views.owner().startsWith(OWNER_PREFIX) ? views.owner().slice(OWNER_PREFIX.length) : undefined);

  function refreshDmPanel(): void {
    const convos = client.dmConversations();
    if (convos.size === 0) {
      dmPanel.setText(" (none — /dm <agent>)");
      return;
    }
    const lines = [...convos.entries()]
      .sort((a, b) => (b[1].msgs.at(-1)?.ts ?? 0) - (a[1].msgs.at(-1)?.ts ?? 0))
      .slice(0, 12)
      .map(([key, c]) => ` ${isGroup(key) ? groupDot(key) : presenceDot(key)} ${OSC8(`fez-dm://open/${key}`, `${isGroup(key) ? "👥" : "@"}${titleOf(key)}`)}${c.unread > 0 ? ` (${c.unread})` : ""}`);
    dmPanel.setText(lines.join("\n"));
  }

  function openDm(key: string): void {
    views.claim(OWNER_PREFIX + key);
    client.markDmRead(key);
    api.ui.clearLog();
    const who = titleOf(key);
    api.ui.notify(
      isGroup(key)
        ? `— group DM with ${who} · end-to-end encrypted, every participant sees every message · plain messages send here, /back returns —`
        : `— private DM with @${who} · end-to-end encrypted, no channel involved · plain messages send here, /back returns —`
    );
    for (const m of client.dmConversations().get(key)?.msgs ?? []) {
      api.ui.appendMessage(client.displayName(m.senderPk), m.text, m.ts);
    }
    api.ui.setStatus("scope", `✉ ${isGroup(key) ? "👥 " : "@"}${who} · private`);
    refreshDmPanel();
  }

  client.on("dmMessage", (dm, ctx) => {
    if (viewingPeer() === dm.peerPk) {
      client.markDmRead(dm.peerPk);
      if (ctx.live) api.ui.appendMessage(client.displayName(dm.senderPk), dm.text, dm.ts);
    } else if (ctx.live && dm.senderPk !== client.pubkey) {
      const from = client.displayName(dm.senderPk);
      const where = isGroup(dm.peerPk) ? ` in 👥 ${titleOf(dm.peerPk)}` : "";
      api.ui.notify(`✉️  DM from ${from}${where}: ${snippet(dm.text)} — /dm ${isGroup(dm.peerPk) ? dm.peerPk : from}`);
    }
    refreshDmPanel();
  });
  client.on("presenceChanged", refreshDmPanel);

  api.registerUrlHandler("fez-dm://open/", (url) => {
    openDm(url.slice("fez-dm://open/".length));
  });

  api.registerCommand("dm", async (args, ctx) => {
    const target = args.trim().replace(/^@/, "");
    if (!target) {
      const convos = client.dmConversations();
      if (convos.size === 0) {
        return ctx.reply("No DM conversations yet. /dm <agent-name|pubkey> starts one — private and end-to-end encrypted, no channel involved.");
      }
      return ctx.reply(
        [...convos.entries()]
          .map(([key, c]) => `• ${isGroup(key) ? "👥 " : "@"}${titleOf(key)}${c.unread > 0 ? ` — ${c.unread} unread` : ""} (/dm ${isGroup(key) ? key : titleOf(key)})`)
          .join("\n")
      );
    }
    // /dm a b c → group conversation with everyone named. A "+"-joined
    // key from the panel/list reopens an existing group directly.
    const names = target.includes("+") ? target.split("+") : target.split(/\s+/);
    const pks: string[] = [];
    for (const raw of names.map((n) => n.trim().replace(/^@/, "")).filter(Boolean)) {
      const pk = /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : client.pkByName(raw);
      if (!pk) return ctx.reply(`No one named "${raw}" seen on this relay — a 64-char hex pubkey works for anyone unnamed.`);
      if (pk !== client.pubkey) pks.push(pk);
    }
    if (pks.length === 0) return ctx.reply("That's you.");
    openDm([...new Set(pks)].sort().join("+"));
  });

  // Plain input while a DM conversation is open goes over the pipe.
  api.registerInputHandler(async (text) => {
    const key = viewingPeer();
    if (!key) return false;
    if (isGroup(key)) await client.sendGroupDm(key.split("+"), text);
    else await client.sendDm(key, text);
    api.ui.appendMessage("You", text);
    refreshDmPanel();
    return true;
  });

  refreshDmPanel();
}
