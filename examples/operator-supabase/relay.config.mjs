import { createClient } from "@supabase/supabase-js";

/**
 * fez-relay operator config: Supabase (Postgres) durability + a ban-list
 * ingest policy. Loaded via:
 *   fez-relay --config examples/operator-supabase/relay.config.mjs
 *
 * Every piece here is one operator's choice behind a generic seam —
 * EventStore for durability, RelayPolicy for enforcement. Swap the
 * client calls for any backend.
 */

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

/**
 * EventStore over fez_events. load() is synchronous by contract, so the
 * fetch happens at module-import time below (the CLI awaits this config
 * module before starting the relay) and load() hands over the result.
 */
const supabaseEventStore = {
  load() {
    return preloaded;
  },
  append(event) {
    void supabase
      .from("fez_events")
      .upsert({
        id: event.id,
        kind: event.kind,
        pubkey: event.pubkey,
        created_at: event.created_at,
        content: event.content,
        tags: event.tags,
        sig: event.sig,
      })
      .then(({ error }) => {
        if (error) console.error("fez_events append failed:", error.message);
      });
  },
};

// Hydrate at config-import time (the CLI awaits this module before
// starting the relay), paging past PostgREST's per-request row cap.
const preloaded = [];
{
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("fez_events")
      .select("*")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fez_events load failed: ${error.message}`);
    preloaded.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
}

/** Ingest policy: reject events from pubkeys in fez_banned_pubkeys (30s cache). */
function banListPolicy() {
  let banned = new Set();
  let fetchedAt = 0;
  return {
    name: "supabase-banlist",
    async onEvent(event) {
      if (Date.now() - fetchedAt > 30_000) {
        const { data, error } = await supabase.from("fez_banned_pubkeys").select("pubkey");
        if (!error) {
          banned = new Set((data ?? []).map((r) => r.pubkey));
          fetchedAt = Date.now();
        }
      }
      return banned.has(event.pubkey)
        ? { accept: false, reason: "blocked: pubkey is banned on this relay" }
        : { accept: true };
    },
  };
}

export default {
  eventStore: supabaseEventStore,
  policies: [banListPolicy()],
};
