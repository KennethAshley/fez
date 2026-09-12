/**
 * Salt evidence fetch — the thin I/O in front of deriveSalt (which holds
 * all the rules and all the tests). One-shot per profile open, cached for
 * the session like the bazaar recordCache. Queries the workspace relay
 * AND the bazaar commons: an agent's republished chits accumulate where
 * it works, not where it was born.
 */
import { verifyEvent } from "nostr-tools/pure";
import { chitEvidence, deriveSalt, type SaltInput, type SaltPanel, type Tier } from "../../fez-client/src/salt.js";
import { RelayConnection } from "../../../src/protocol/relay.js";

export type { SaltPanel, Tier };

interface RawEvent {
  id: string; pubkey: string; kind: number; content: string;
  tags: string[][]; created_at: number;
}

// Cache evidence, not a viewer's relationship to its signers.
const evidenceCache = new Map<string, Pick<SaltInput, "evidence" | "attestations">>();

/** Bust one agent's cached panel — the vouch button just changed the
 *  evidence, and a session-cached tier would deny it happened. */
export function invalidateSaltPanel(pk: string): void {
  for (const key of evidenceCache.keys()) if (key.startsWith(`${pk}:`)) evidenceCache.delete(key);
}

const tag = (e: RawEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];

export async function fetchSaltPanel(opts: {
  pk: string;
  viewer: string;
  relays: string[];
  isViewerAgent(pk: string): boolean;
  inViewerCircle(pk: string): boolean;
}): Promise<SaltPanel | "error"> {
  const cacheKey = `${opts.pk}:${[...new Set(opts.relays)].sort().join(",")}`;
  const hit = evidenceCache.get(cacheKey);
  if (hit) return deriveSalt({ ...opts, agent: opts.pk, ...hit });
  const relay = new RelayConnection({ urls: opts.relays });
  try {
    await relay.connect();
    // connect()/query() never reject on a dead relay (fetchRecord's
    // comment tells the whole story) — so without this, an unreachable
    // network produced four empty queries and the UI asserted "no one
    // you can verify has attested this agent's work" AS FACT. Offline
    // is "unknown", never "nameless". The error is deliberately NOT
    // cached: reconnecting and reopening the profile should recover.
    if (!relay.health().some((h) => h.connected)) return "error";
    const q = async (filter: object): Promise<RawEvent[]> => {
      const events = (await relay.query([filter as never])) as unknown as RawEvent[];
      // Same relay/dedup posture as fetchRecord: merge by id, verify sigs.
      const byId = new Map(events.filter((e) => verifyEvent(e as never)).map((e) => [e.id, e]));
      return [...byId.values()];
    };
    const [chits, vouches, pays, attestIn] = await Promise.all([
      q({ kinds: [47007], "#p": [opts.pk], limit: 500 }),
      q({ kinds: [47008], "#d": [opts.pk], limit: 500 }),
      q({ kinds: [47040], "#p": [opts.pk], limit: 500 }),
      q({ kinds: [47006], "#p": [opts.pk], limit: 200 }),
    ]);
    const owners = [...new Set(attestIn.map((e) => e.pubkey))];
    const siblingEvents = owners.length
      ? await q({ kinds: [47006], authors: owners, limit: 500 })
      : [];

    const evidence = chitEvidence(opts.pk, [...chits, ...pays]);
    // Latest vouch per signer; empty content = revoked.
    const latestVouch = new Map<string, RawEvent>();
    for (const v of vouches) {
      const prev = latestVouch.get(v.pubkey);
      if (!prev || v.created_at > prev.created_at) latestVouch.set(v.pubkey, v);
    }
    for (const v of latestVouch.values()) {
      if (!v.content) continue;
      evidence.push({ signer: v.pubkey, kind: "vouch", note: v.content, at: v.created_at, moneyBacked: false });
    }

    const attestations = [...attestIn, ...siblingEvents]
      .map((e) => ({ owner: e.pubkey, agent: tag(e, "p") ?? "" }))
      .filter((a) => a.agent);

    const panel = deriveSalt({
      agent: opts.pk,
      viewer: opts.viewer,
      evidence,
      attestations,
      isViewerAgent: opts.isViewerAgent,
      inViewerCircle: opts.inViewerCircle,
    });
    evidenceCache.set(cacheKey, { evidence, attestations });
    return panel;
  } catch {
    return "error";
  } finally {
    relay.disconnect();
  }
}

export function tierLabel(tier: Tier): string {
  switch (tier) {
    case "salted": return "salted";
    case "circle": return "salt from your circle";
    case "spoken-of": return "spoken of";
    case "nameless": return "nameless";
  }
}

/** Hover copy for the tier chip — what the evidence actually is, from
 *  YOUR vantage (the same event reads differently to a stranger). */
export function tierTitle(tier: Tier): string {
  switch (tier) {
    case "salted": return "you or one of your agents accepted work or vouched for this agent";
    case "circle": return "someone in your circle accepted work or vouched for this agent";
    case "spoken-of": return "public chits or vouches from keys outside your circle; a key count does not establish trust";
    case "nameless": return "no chits or active vouches found in the queried relays";
  }
}
