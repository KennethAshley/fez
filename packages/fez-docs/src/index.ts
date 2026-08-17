import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FezExtensionAPI, NostrEvent } from "./api-types.js";
import type { FezClient } from "@fez/client";

/**
 * fez-docs — the channel-doc view, a standalone installable extension
 * over @fez/client (which owns all doc state and trust rules). This
 * file renders: the DOCS sidebar box, the /doc view + commands, and
 * the two-way markdown disk mirror (~/.fez/docs/<community>/<channel>.md
 * — new versions write the file, saving the file publishes the next
 * version). Split out of fez-communities the moment api.client made
 * shared state possible — the store model working as intended.
 */
export default function docs(api: FezExtensionAPI): void {
  if (!api.client) return;
  const client = api.client as FezClient;
  const views = api.ui.viewBus;

  const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
  const OSC8 = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;

  const docsPanel = api.ui.createSidePanel({ title: "docs", icon: "📄", order: 20 });

  function refreshDocsPanel(): void {
    const rows: string[] = [];
    for (const [channelId, info] of client.docsByChannel()) {
      const ref = client.channelRef(channelId);
      if (!ref) continue;
      rows.push(` ${OSC8(`fez-doc://open/${channelId}`, `#${ref.name}`)} ${DIM(`v${info.count} · ${info.latestAuthor === client.pubkey ? "you" : client.displayName(info.latestAuthor)}`)}`);
    }
    docsPanel.setText(rows.length > 0 ? rows.join("\n") : " (none — /doc set)");
  }

  function renderDocView(doc: NostrEvent | undefined, versionNo: number, total: number, channelName: string): void {
    api.ui.clearLog();
    if (!doc) {
      api.ui.appendMessage("doc", `#${channelName} has no doc yet. Start one: /doc set <text> — one living document per channel, editable by any member (agents included). /back returns.`);
      return;
    }
    api.ui.notify(`— #${channelName} doc · v${versionNo}/${total} · last edit by ${client.displayName(doc.pubkey)} — /doc history · /doc set|append <text> · /back —`);
    api.ui.appendMessage(client.displayName(doc.pubkey), doc.content, doc.created_at);
  }

  async function openDocView(channelId: string, communityId: string, channelName: string, versionNo?: number): Promise<void> {
    const versions = await client.docVersions(channelId, communityId);
    const doc = versionNo ? versions[versionNo - 1] : versions.at(-1);
    views.claim("docs");
    renderDocView(doc as NostrEvent | undefined, versionNo ?? versions.length, versions.length, channelName);
    api.ui.setStatus("scope", `${client.channelRef(channelId)?.communityName ?? ""}/#${channelName} ▸ doc`);
  }

  // ── Disk mirror ─────────────────────────────────────────────────────────

  const DOCS_DIR = path.join(os.homedir(), ".fez", "docs");
  const mirrorPathByChannel = new Map<string, string>();
  const lastMirrored = new Map<string, string>();
  const sanitizeName = (s: string) => s.replace(/[^\w.-]+/g, "_");

  function mirrorWrite(channelId: string): void {
    const info = client.docsByChannel().get(channelId);
    const ref = client.channelRef(channelId);
    if (!info || !ref) return;
    try {
      const dir = path.join(DOCS_DIR, sanitizeName(ref.communityName));
      const file = path.join(dir, `${sanitizeName(ref.name)}.md`);
      mirrorPathByChannel.set(channelId, file);
      if (lastMirrored.get(file) === info.latestContent) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, info.latestContent);
      lastMirrored.set(file, info.latestContent);
    } catch { /* disk trouble — mirror is a convenience, the relay is canonical */ }
  }

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
          if (!channelId) return;
          let content: string;
          try {
            content = fs.readFileSync(full, "utf-8");
          } catch {
            return;
          }
          if (content === lastMirrored.get(full)) return; // our own write
          const info = client.docsByChannel().get(channelId);
          const ref = client.channelRef(channelId);
          if (!ref || content.trim() === (info?.latestContent ?? "").trim()) return;
          lastMirrored.set(full, content);
          void client
            .publishDoc(channelId, ref.communityId, content, info?.latestId || undefined)
            .then(() => api.ui.notify(`📄 ${path.basename(full)} saved → published doc v${(info?.count ?? 0) + 1} to #${ref.name}`))
            .catch(() => api.ui.notify(`⚠️ couldn't publish ${path.basename(full)} — relay unreachable?`));
        }, 400)
      );
    });
  } catch { /* fs.watch unavailable — mirror stays read-only */ }

  // ── Wiring ──────────────────────────────────────────────────────────────

  client.on("docChanged", (channelId) => {
    refreshDocsPanel();
    mirrorWrite(channelId);
    if (views.owner() === "docs" && client.state.scope?.channelId === channelId) {
      const ref = client.channelRef(channelId);
      if (ref) void openDocView(channelId, ref.communityId, ref.name);
    } else if (
      client.state.scope?.channelId === channelId &&
      client.docsByChannel().get(channelId)?.latestAuthor !== client.pubkey
    ) {
      api.ui.notify(`📄 ${client.displayName(client.docsByChannel().get(channelId)!.latestAuthor)} updated the channel doc — /doc`);
    }
  });
  client.on("channelsChanged", refreshDocsPanel);
  client.on("presenceChanged", refreshDocsPanel);

  api.registerUrlHandler("fez-doc://open/", (url) => {
    const channelId = url.slice("fez-doc://open/".length);
    const ref = client.channelRef(channelId);
    if (!ref) return;
    client.setScope(ref.communityId, channelId);
    void openDocView(channelId, ref.communityId, ref.name);
  });

  api.registerCommand("doc", async (args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel — /join <channel> first.");
    const [sub, ...rest] = args.trim().split(/\s+/);

    if (sub === "set" || sub === "append") {
      const text = args.trim().slice(sub.length).trim().replace(/\\n/g, "\n");
      if (!text) return ctx.reply(`Usage: /doc ${sub} <markdown — \\n for newlines>`);
      const versions = await client.docVersions(current.channel.id, current.community.id);
      const latest = versions.at(-1);
      const content = sub === "append" && latest ? `${latest.content}\n\n${text}` : text;
      await client.publishDoc(current.channel.id, current.community.id, content, latest?.id);
      ctx.reply(`📄 doc ${sub === "append" ? "appended" : "updated"} (v${versions.length + 1}). /doc to read.`);
      return;
    }

    if (sub === "history") {
      const versions = await client.docVersions(current.channel.id, current.community.id);
      if (versions.length === 0) return ctx.reply("No doc yet — /doc set <text> starts one.");
      const baseOf = (v: { tags: string[][] }) => v.tags.find((t) => t[0] === "base")?.[1];
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
            return `• v${i + 1} — ${client.displayName(v.pubkey)}, ${new Date(v.created_at * 1000).toLocaleString()} (${v.content.length} chars)${fork}${i === versions.length - 1 ? " ← current" : ` — /doc show ${i + 1}`}`;
          })
          .join("\n")
      );
      return;
    }

    if (sub === "show") {
      const no = Number(rest[0]);
      if (!no) return ctx.reply("Usage: /doc show <version from /doc history>");
      await openDocView(current.channel.id, current.community.id, current.channel.name, no);
      return;
    }

    await openDocView(current.channel.id, current.community.id, current.channel.name);
  });

  // Startup panel fill happens as docChanged/channelsChanged fire during
  // client hydration; paint the empty state immediately.
  refreshDocsPanel();
}
