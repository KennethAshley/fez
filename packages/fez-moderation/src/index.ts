import type { FezExtensionAPI } from "./api-types.js";
import type { FezClient } from "@fezchat/client";

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
  // `nostr` is optional on the real API — undefined outside the
  // TUI/sentinel. Every verb here publishes or decrypts, so there is
  // nothing useful to register without it. Captured in a local so the
  // narrowing survives into the async command handlers.
  if (!api.client || !api.nostr) return;
  const client = api.client as FezClient;
  const nostr = api.nostr;

  const resolvePk = (raw: string): string | undefined => {
    const name = raw.trim().replace(/^@/, "");
    return /^[0-9a-f]{64}$/i.test(name) ? name.toLowerCase() : client.pkByName(name);
  };

  api.registerCommand("report", async (args, ctx) => {
    const current = client.state.currentChannel();
    if (!current) return ctx.reply("Not in a channel.");
    const [who, ...reasonParts] = args.trim().split(/\s+/);
    const reason = reasonParts.join(" ");
    if (!who || !reason) return ctx.reply("Usage: /report <name|pubkey> <reason> — encrypted so only the workspace owner can read it.");
    const targetPk = resolvePk(who);
    if (!targetPk) return ctx.reply(`No one named "${who}" here.`);
    // The moderator is the workspace owner, per the relay's NIP-11 —
    // there is no community creator to address any more. Unclaimed relay
    // means there is nobody to encrypt to, and publishing a report only
    // the reporter can read is worse than refusing.
    const owner = client.state.workspace.owner;
    if (!owner) return ctx.reply("This relay is unclaimed — no owner to send a report to.");
    await nostr.publish({
      kind: KIND_REPORT,
      // Scoped by channel now that the workspace is flat: ["h", channelId]
      // is what every other channel-scoped kind uses, and what the relay's
      // membership policy already keys on.
      tags: [["h", current.id], ["p", owner]],
      content: nostr.encrypt(owner, JSON.stringify({ targetPk, reason, ts: Date.now() })),
    });
    ctx.reply(`🚩 reported ${client.displayName(targetPk)} to the workspace owner — only they can read the reason.`);
  });

  api.registerCommand("reports", async (_args, ctx) => {
    const events = await nostr.query([{ kinds: [KIND_REPORT], "#p": [client.pubkey], limit: 200 }]);
    const rows: string[] = [];
    for (const event of events.sort((a, b) => b.created_at - a.created_at)) {
      try {
        const r = JSON.parse(nostr.decrypt(event.pubkey, event.content)) as { targetPk?: string; reason?: string };
        if (!r.targetPk) continue;
        // Older reports carry ["c", communityId] from before the flat
        // workspace; read both so a queue built up under the old shape
        // still renders instead of silently showing "?".
        const scope = event.tags.find((t) => t[0] === "h")?.[1] ?? event.tags.find((t) => t[0] === "c")?.[1];
        const where = scope ? client.state.workspace.channels.get(scope)?.name ?? scope.slice(0, 8) : "?";
        rows.push(`• ${client.displayName(r.targetPk)} — "${r.reason}" (by ${client.displayName(event.pubkey)}, ${where}) → /ban ${client.displayName(r.targetPk)}`);
      } catch { /* not addressed to us */ }
    }
    ctx.reply(rows.length ? [`**Reports** (${rows.length})`, ...rows].join("\n") : "No reports addressed to you.");
  });

  // A ban is WORKSPACE-wide now — one roster, one ban list. So these
  // three deliberately do not require a current channel: asking someone
  // to stand in a room before banning a person from the whole workspace
  // would imply a scope the ban does not have.
  api.registerCommand("ban", async (args, ctx) => {
    const targetPk = resolvePk(args);
    if (!targetPk) return ctx.reply("Usage: /ban <name|pubkey> — owner-only; they become a non-member of the whole workspace until /unban.");
    try {
      const name = await client.banUser(targetPk);
      ctx.reply(`⛔ banned ${name} from ${client.state.workspace.name} — their messages stop rendering for every member; history stays. /unban ${name} reverses it.`);
    } catch (err) {
      ctx.reply(`Can't ban: ${err instanceof Error ? err.message : err}`);
    }
  });

  api.registerCommand("unban", async (args, ctx) => {
    const targetPk = resolvePk(args);
    if (!targetPk) return ctx.reply("Usage: /unban <name|pubkey>");
    try {
      const name = await client.unbanUser(targetPk);
      ctx.reply(`✅ unbanned ${name} — full standing restored.`);
    } catch (err) {
      ctx.reply(`Can't unban: ${err instanceof Error ? err.message : err}`);
    }
  });

  api.registerCommand("bans", async (_args, ctx) => {
    const banned = [...client.state.workspace.banned];
    ctx.reply(
      banned.length
        ? `⛔ banned in ${client.state.workspace.name}: ${banned.map((pk) => client.displayName(pk)).join(", ")}`
        : "No one is banned here."
    );
  });
}
