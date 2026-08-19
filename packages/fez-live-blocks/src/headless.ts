import type { FezExtensionAPI, NostrEvent } from "./api-types.js";
import { formatLiveBlock, isDue, parseLiveBlock, parseLiveCommand, LIVE_LANG } from "./format.js";

/**
 * fez-live-blocks, headless part — /live in the TUI and any bare client.
 * The block is plain markdown in the channel doc, so a client without
 * the gui part still sees the agent's latest output (just unstyled).
 */

interface ClientLike {
  state: { scope?: { channelId: string } };
  docsByChannel(): ReadonlyMap<string, { latestContent: string; latestId: string }>;
  publishDoc(channelId: string, content: string, baseId?: string): Promise<void>;
}

export default function liveBlocks(api: FezExtensionAPI): void {
  registerScheduler(api); // background hosts (the sentinel) have no client — register first

  const client = api.client as ClientLike | undefined;
  if (!client) return;

  api.registerCommand("live", async (args, ctx) => {
    const parsed = parseLiveCommand(args);
    if ("error" in parsed) {
      ctx.reply(`◉ ${parsed.error}`);
      return;
    }
    if (!client.state.scope) {
      ctx.reply("◉ open a channel first.");
      return;
    }
    const { channelId } = client.state.scope;
    const doc = client.docsByChannel().get(channelId);
    const next = `${doc?.latestContent?.trim() ? doc.latestContent.trimEnd() + "\n\n" : ""}${formatLiveBlock(parsed.block)}\n`;
    await client.publishDoc(channelId, next, doc?.latestId);
    ctx.reply(`◉ live block added to the channel doc — @${parsed.block.agent} owns it. Comment on it (or ↻ in the GUI) to refresh.`);
  });

}

function registerScheduler(api: FezExtensionAPI): void {
  // ── the scheduler ─────────────────────────────────────────────────────
  // Runs only in the sentinel (the always-on host). Every tick: find the
  // newest version of each doc, parse its live blocks, and fire a refresh
  // comment for the ones that are due — the same comment the ↻ button
  // publishes, so there is exactly one refresh path.
  //
  // Three rules keep this honest:
  //  1. OWNERSHIP — we only fire blocks whose agent WE attested (kind
  //     47006 from our key). Agents run on their owner's machine, so a
  //     second person's sentinel seeing the same doc stays quiet instead
  //     of double-firing and racing the same version.
  //  2. NO BACKLOG — a machine that slept wakes up with overdue blocks;
  //     each fires ONCE, never once per missed window.
  //  3. BUDGET — refreshes are real harness turns, so at most
  //     MAX_PER_TICK go out per pass and a block we just fired is not
  //     re-fired until its next window (the agent stamps updated=).
  const MAX_PER_TICK = 3;
  api.registerScheduledTask("live-blocks", 5 * 60_000, async ({ nostr, ownerPubkey }) => {
    const [docs, attestations] = await Promise.all([
      nostr.query([{ kinds: [40100], limit: 500 }]) as Promise<NostrEvent[]>,
      nostr.query([{ kinds: [47006], authors: [ownerPubkey], limit: 200 }]) as Promise<NostrEvent[]>,
    ]);
    const mineByPk = new Set(attestations.flatMap((e) => e.tags.filter((t) => t[0] === "p").map((t) => t[1])));
    if (mineByPk.size === 0) return; // no agents of ours — nothing to drive

    // agent NAME → pubkey, so a block's agent=<name> resolves to a key we attested
    const profiles = (await nostr.query([{ kinds: [47000], limit: 300 }])) as NostrEvent[];
    const pkByName = new Map<string, string>();
    for (const profile of profiles.sort((a, b) => a.created_at - b.created_at)) {
      try {
        const name = (JSON.parse(profile.content) as { name?: string }).name;
        if (name) pkByName.set(name.toLowerCase(), profile.pubkey);
      } catch { /* not a profile we can read */ }
    }

    // newest version per doc (channel doc keyed by h, wiki page by d)
    const newest = new Map<string, NostrEvent>();
    for (const doc of docs) {
      const slug = doc.tags.find((t) => t[0] === "d")?.[1];
      const channelId = doc.tags.find((t) => t[0] === "h")?.[1];
      const key = slug ? `d:${slug}` : `h:${channelId}`;
      const prior = newest.get(key);
      if (!prior || doc.created_at > prior.created_at) newest.set(key, doc);
    }

    let fired = 0;
    for (const doc of newest.values()) {
      if (fired >= MAX_PER_TICK) break;
      const channelId = doc.tags.find((t) => t[0] === "h")?.[1];
      if (!channelId) continue;
      const slug = doc.tags.find((t) => t[0] === "d")?.[1];
      for (const fence of doc.content.matchAll(new RegExp("```" + LIVE_LANG + "([^\\n]*)\\n([\\s\\S]*?)```", "g"))) {
        if (fired >= MAX_PER_TICK) break;
        const block = parseLiveBlock(fence[1], fence[2]);
        if (!block.agent || !isDue(block, Date.now())) continue;
        const agentPk = pkByName.get(block.agent.toLowerCase());
        if (!agentPk || !mineByPk.has(agentPk)) continue; // not ours to drive
        const stamp = Math.floor(Date.now() / 1000);
        await nostr.publish({
          kind: 40101,
          tags: [
            ["h", channelId],
            ...(slug ? [["d", slug]] : []),
            ["anchor", ("```" + LIVE_LANG + fence[1]).slice(0, 300)],
            ["p", agentPk],
          ],
          content:
            `@${block.agent} refresh this live block (scheduled). Do the task below, then rewrite ONLY this block in the document — ` +
            `keep the \`\`\`${LIVE_LANG}\`\`\` fence and its agent=/every= attributes, set updated=${stamp}, put your result under the --- line, ` +
            `and leave the rest of the document untouched.\n\nTask: ${block.prompt}`,
        });
        fired++;
      }
    }
    if (fired > 0) console.log(`◉ live-blocks: fired ${fired} scheduled refresh${fired === 1 ? "" : "es"}`);
  });
}
