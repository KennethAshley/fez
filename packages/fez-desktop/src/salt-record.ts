/**
 * Salt evidence fetch — the thin I/O in front of deriveSalt (which holds
 * all the rules and all the tests). One-shot per profile open, cached for
 * the session like the bazaar recordCache. Queries the workspace relay
 * AND the bazaar commons: an agent's republished chits accumulate where
 * it works, not where it was born.
 */
import { verifyEvent } from "nostr-tools/pure";
import { deriveSalt, type SaltEvidence, type SaltPanel, type Tier } from "../../fez-client/src/salt.js";
import { RelayConnection } from "../../../src/protocol/relay.js";

export type { SaltPanel, Tier };

interface RawEvent {
  id: string; pubkey: string; kind: number; content: string;
  tags: string[][]; created_at: number;
}

const panelCache = new Map<string, SaltPanel | "error">();

const tag = (e: RawEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];

export async function fetchSaltPanel(opts: {
  pk: string;
  viewer: string;
  relays: string[];
  isViewerAgent(pk: string): boolean;
  inViewerCircle(pk: string): boolean;
}): Promise<SaltPanel> {
  const hit = panelCache.get(opts.pk);
  if (hit && hit !== "error") return hit;
  const relay = new RelayConnection({ urls: opts.relays });
  try {
    await relay.connect();
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

    const evidence: SaltEvidence[] = [];
    for (const e of [...chits, ...pays]) {
      if (tag(e, "p") !== opts.pk) continue;
      evidence.push({ signer: e.pubkey, kind: "chit", workId: tag(e, "e"), note: e.content,
        at: e.created_at, moneyBacked: e.kind === 47040 });
    }
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
    panelCache.set(opts.pk, panel);
    return panel;
  } finally {
    relay.disconnect();
  }
}

export function tierLabel(tier: Tier): string {
  switch (tier) {
    case "salted": return "salted";
    case "circle": return "vouched by your circle";
    case "spoken-of": return "spoken of";
    case "nameless": return "nameless";
  }
}
