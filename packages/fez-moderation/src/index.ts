import type { FezExtensionAPI } from "./api-types.js";
import type { FezClient } from "@fez/client";

/**
 * fez-moderation — the moderation verbs (#42), store-model:
 *
 * - /report <who> <reason>: kind 1984 with the accusation NIP-44-encrypted
 *   to the community CREATOR — a public relay must never carry plaintext
 *   reports. Observers learn only "someone reported something here".
 * - /reports: creator-only queue — decrypts every 1984 addressed to you.
 * - /ban | /unban <who>: creator-signed 30047 ban list (latest wins, same
 *   trust chain as the roster). Enforcement lives elsewhere by design:
 *   every client's trust rules treat banned pubkeys as non-members, and a
 *   relay running moderationPolicy() rejects their writes at ingest.
 */

const KIND_REPORT = 1984;

export default function moderation(api: FezExtensionAPI): void {
  if (!api.client) return;
  const client = api.client as FezClient;

  const resolvePk = (raw: string): string | undefined => {
    const name = raw.trim().replace(/^@/, "");
    return /^[0-9a-f]{64}$/i.test(name) ? name.toLowerCase() : client.pkByName(name);
  };

  api.registerCommand("report", async (args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const [who, ...reasonParts] = args.trim().split(/\s+/);
    const reason = reasonParts.join(" ");
    if (!who || !reason) return ctx.reply("Usage: /report <name|pubkey> <reason> — encrypted so only the community creator can read it.");
    const targetPk = resolvePk(who);
    if (!targetPk) return ctx.reply(`No one named "${who}" here.`);
    const creator = current.community.creator;
    await api.nostr.publish({
      kind: KIND_REPORT,
      tags: [["c", current.community.id], ["p", creator]],
      content: api.nostr.encrypt(creator, JSON.stringify({ targetPk, reason, ts: Date.now() })),
    });
    ctx.reply(`🚩 reported ${client.displayName(targetPk)} to the community creator — only they can read the reason.`);
  });

  api.registerCommand("reports", async (_args, ctx) => {
    const events = await api.nostr.query([{ kinds: [KIND_REPORT], "#p": [client.pubkey], limit: 200 }]);
    const rows: string[] = [];
    for (const event of events.sort((a, b) => b.created_at - a.created_at)) {
      try {
        const r = JSON.parse(api.nostr.decrypt(event.pubkey, event.content)) as { targetPk?: string; reason?: string };
        if (!r.targetPk) continue;
        const community = event.tags.find((t) => t[0] === "c")?.[1];
        const communityName = community ? client.state.communities.get(community)?.name ?? community.slice(0, 8) : "?";
        rows.push(`• ${client.displayName(r.targetPk)} — "${r.reason}" (by ${client.displayName(event.pubkey)}, ${communityName}) → /ban ${client.displayName(r.targetPk)}`);
      } catch { /* not addressed to us */ }
    }
    ctx.reply(rows.length ? [`**Reports** (${rows.length})`, ...rows].join("\n") : "No reports addressed to you.");
  });

  api.registerCommand("ban", async (args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const targetPk = resolvePk(args);
    if (!targetPk) return ctx.reply("Usage: /ban <name|pubkey> — creator-only; they become a non-member everywhere until /unban.");
    try {
      const name = await client.banUser(current.community.id, targetPk);
      ctx.reply(`⛔ banned ${name} from ${current.community.name} — their messages stop rendering for every member; history stays. /unban ${name} reverses it.`);
    } catch (err) {
      ctx.reply(`Can't ban: ${err instanceof Error ? err.message : err}`);
    }
  });

  api.registerCommand("unban", async (args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const targetPk = resolvePk(args);
    if (!targetPk) return ctx.reply("Usage: /unban <name|pubkey>");
    try {
      const name = await client.unbanUser(current.community.id, targetPk);
      ctx.reply(`✅ unbanned ${name} — full standing restored.`);
    } catch (err) {
      ctx.reply(`Can't unban: ${err instanceof Error ? err.message : err}`);
    }
  });

  api.registerCommand("bans", async (_args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const banned = [...current.community.banned];
    ctx.reply(banned.length ? `⛔ banned in ${current.community.name}: ${banned.map((pk) => client.displayName(pk)).join(", ")}` : "No one is banned here.");
  });
}
