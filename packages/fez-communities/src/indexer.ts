#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RelayConnection,
  CapabilityClient,
  KIND_AGENT_METADATA,
  KIND_CHANNEL_MESSAGE,
  KIND_MEMBERSHIP,
  KIND_THREAD_SUMMARY,
  resolveRelays,
} from "@fez/protocol";
import { loadServiceKey, parseThreadRef, resolveChannels } from "./service-common.js";

/**
 * Thread indexer — the "derived state" primitive proved as a standing
 * service (bucket 1 of the Buzz-primitives roadmap). Buzz's relay keeps a
 * thread_metadata table in Postgres and publishes relay-signed summary
 * overlays; fez decentralizes the same job: this service watches channel
 * messages, maintains thread stats in whatever storage its operator brings
 * (IndexStore — the default is a JSON file; swapping in Supabase/Postgres/
 * anything is implementing two methods, and securing it is the operator's
 * concern, not fez's), and publishes signed 39005 summaries back to the
 * relay. Clients that missed messages get accurate counts anyway.
 *
 * Trust: consumers only accept summaries from channel members — /invite
 * this service's pubkey (role: bot) like any agent.
 *
 * Config (env): FEZ_INDEXER_CHANNELS (names or ids, comma-separated),
 * FEZ_RELAY. Run via `fez run dist/indexer.js`.
 */

export interface ThreadStats {
  channelId: string;
  communityId: string;
  replyCount: number;
  lastReplyAt: number;
  participants: string[];
}

/** Operator-swappable storage. Two methods; bring any backend. */
export interface IndexStore {
  loadAll(): Promise<Record<string, ThreadStats>>;
  upsert(rootId: string, stats: ThreadStats): Promise<void>;
}

class JsonFileStore implements IndexStore {
  private file = path.join(os.homedir(), ".fez", "indexer", "threads.json");
  private cache: Record<string, ThreadStats> = {};

  async loadAll(): Promise<Record<string, ThreadStats>> {
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async upsert(rootId: string, stats: ThreadStats): Promise<void> {
    this.cache[rootId] = stats;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), "utf-8");
  }
}

const PUBLISH_DEBOUNCE_MS = 2000;

async function main() {
  const relayUrls = resolveRelays();
  const channelSpecs = (process.env.FEZ_INDEXER_CHANNELS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (channelSpecs.length === 0) {
    console.error("Usage: FEZ_INDEXER_CHANNELS=<name-or-id,...> fez run indexer.js");
    process.exit(1);
  }

  const client = new CapabilityClient({ relay: relayUrls, privateKey: loadServiceKey("indexer") });
  const relay = new RelayConnection({ urls: relayUrls, authSigner: client.authSigner });
  await relay.connect();
  const myPubkey = client.getPubkey();

  const channels = await resolveChannels(relay, channelSpecs, relayUrls.join(", "));

  // Membership check (advisory): summaries from a non-member are ignored
  // by consumers, so say so loudly rather than indexing into the void.
  const membershipEvents = await relay.query([{ kinds: [KIND_MEMBERSHIP], "#d": channels }]);
  const latestByChannel = new Map<string, { created_at: number; members: Set<string> }>();
  for (const e of membershipEvents) {
    const d = e.tags.find((t) => t[0] === "d")?.[1];
    if (!d) continue;
    const existing = latestByChannel.get(d);
    if (existing && e.created_at < existing.created_at) continue;
    latestByChannel.set(d, {
      created_at: e.created_at,
      members: new Set(e.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1])),
    });
  }
  for (const channelId of channels) {
    if (!latestByChannel.get(channelId)?.members.has(myPubkey)) {
      console.warn(`⚠️  Not a member of channel ${channelId} — summaries will be ignored until the creator runs /invite ${myPubkey} bot`);
    }
  }

  // Bring-your-own storage: FEZ_INDEXER_STORE points at a module whose
  // default export implements IndexStore (loadAll/upsert) over any
  // backend — Supabase, Postgres, whatever; its security is the
  // operator's concern. Default: a JSON file.
  let store: IndexStore = new JsonFileStore();
  if (process.env.FEZ_INDEXER_STORE) {
    const mod = await import(new URL(`file://${path.resolve(process.env.FEZ_INDEXER_STORE)}`).href);
    store = typeof mod.default === "function" ? await mod.default() : mod.default;
    console.log(`🗄  index store: ${process.env.FEZ_INDEXER_STORE}`);
  }
  const stats = await store.loadAll();

  // Identity announcement, so member lists show "indexer" not hex.
  await relay.publish(
    client.signEvent({
      kind: KIND_AGENT_METADATA,
      tags: [],
      content: JSON.stringify({ name: "indexer", supported_tasks: ["thread-index"] }),
    })
  );

  const pendingPublish = new Map<string, ReturnType<typeof setTimeout>>();

  function fold(event: { id: string; pubkey: string; created_at: number; tags: string[][] }): string | undefined {
    const { rootId } = parseThreadRef(event.tags);
    if (!rootId) return undefined; // roots don't need summarizing until they get replies
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId || !channels.includes(channelId)) return undefined;
    const current = stats[rootId] ?? { channelId, communityId, replyCount: 0, lastReplyAt: 0, participants: [] };
    current.replyCount += 1;
    current.lastReplyAt = Math.max(current.lastReplyAt, event.created_at);
    if (!current.participants.includes(event.pubkey)) current.participants.push(event.pubkey);
    stats[rootId] = current;
    return rootId;
  }

  function schedulePublish(rootId: string): void {
    // Debounced per root so reply bursts coalesce into one summary.
    clearTimeout(pendingPublish.get(rootId));
    pendingPublish.set(
      rootId,
      setTimeout(() => {
        pendingPublish.delete(rootId);
        const s = stats[rootId];
        void store.upsert(rootId, s);
        void relay
          .publish(
            client.signEvent({
              kind: KIND_THREAD_SUMMARY,
              tags: [["d", rootId], ["h", s.channelId], ["c", s.communityId]],
              content: JSON.stringify({
                replyCount: s.replyCount,
                lastReplyAt: s.lastReplyAt,
                participants: s.participants,
              }),
            })
          )
          .then(() => console.log(`📊 thread ${rootId.slice(0, 8)}… → ${s.replyCount} replies`))
          .catch((err) => console.error("publish failed:", err));
      }, PUBLISH_DEBOUNCE_MS)
    );
  }

  // Backfill: fold every historical reply, then publish each thread once.
  // Stats reset on backfill (recount from scratch) so restarts don't
  // double-count what the store already held.
  for (const key of Object.keys(stats)) delete stats[key];
  const history = await relay.query([{ kinds: [KIND_CHANNEL_MESSAGE], "#h": channels }]);
  const touched = new Set<string>();
  for (const event of history.sort((a, b) => a.created_at - b.created_at)) {
    const rootId = fold(event);
    if (rootId) touched.add(rootId);
  }
  for (const rootId of touched) schedulePublish(rootId);
  console.log(`🟢 indexer standing by: ${channels.length} channel(s), ${touched.size} thread(s) backfilled, on ${relayUrls.join(", ")}`);
  console.log(`   Pubkey: ${myPubkey}`);

  relay.subscribe(
    [{ kinds: [KIND_CHANNEL_MESSAGE], "#h": channels, since: Math.floor(Date.now() / 1000) }],
    (event) => {
      const rootId = fold(event);
      if (rootId) schedulePublish(rootId);
    }
  );

  process.on("SIGINT", () => {
    relay.disconnect();
    console.log("\n🔴 indexer stopped.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
