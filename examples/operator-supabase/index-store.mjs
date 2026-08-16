import { createClient } from "@supabase/supabase-js";

/**
 * IndexStore over fez_thread_stats — the indexer's derived state in
 * Postgres instead of the default JSON file. Loaded via:
 *   FEZ_INDEXER_STORE=examples/operator-supabase/index-store.mjs
 */
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

export default {
  async loadAll() {
    const { data, error } = await supabase.from("fez_thread_stats").select("*");
    if (error) throw new Error(`fez_thread_stats load failed: ${error.message}`);
    const stats = {};
    for (const row of data ?? []) {
      stats[row.root_id] = {
        channelId: row.channel_id,
        communityId: row.community_id,
        replyCount: row.reply_count,
        lastReplyAt: row.last_reply_at,
        participants: row.participants,
      };
    }
    return stats;
  },

  async upsert(rootId, s) {
    const { error } = await supabase.from("fez_thread_stats").upsert({
      root_id: rootId,
      channel_id: s.channelId,
      community_id: s.communityId,
      reply_count: s.replyCount,
      last_reply_at: s.lastReplyAt,
      participants: s.participants,
    });
    if (error) console.error("fez_thread_stats upsert failed:", error.message);
  },
};
