import { finalizeEvent, type Event as NostrEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import type { Filter } from "nostr-tools";

/**
 * Threshold consent over EXISTING kinds (spec §consent): the request is
 * an ordinary channel message (47103) p-tagging the owner; authorization
 * is the OWNER's kind-7 reaction e-tagging that request. No new kinds —
 * any fez client renders the request and can approve it today.
 */

export const KIND_CHANNEL_MESSAGE = 47103; // matches src/protocol/kinds.ts
export const KIND_REACTION = 7;

export type SignedNostrEvent = NostrEvent;

export interface ConsentRelay {
  publish(event: SignedNostrEvent): Promise<void>;
  subscribe(
    filter: Filter,
    onEvent: (ev: SignedNostrEvent) => void
  ): () => void;
}

const APPROVE = new Set(["✅", "+"]);
const DECLINE = new Set(["❌", "-"]);

export function buildConsentRequest(opts: {
  agentSecretHex: string;
  channelId: string;
  ownerPk: string;
  text: string;
}): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: KIND_CHANNEL_MESSAGE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", opts.channelId],
        ["p", opts.ownerPk],
      ],
      content: opts.text,
    },
    hexToBytes(opts.agentSecretHex)
  );
}

export function awaitDecision(
  relay: ConsentRelay,
  requestId: string,
  ownerPk: string,
  timeoutMs: number
): Promise<"approved" | "declined" | "timeout"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: "approved" | "declined" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(v);
    };
    const filter: Filter = {
      kinds: [KIND_REACTION],
      "#e": [requestId],
      authors: [ownerPk],
    };
    const unsub = relay.subscribe(filter, (ev) => {
      // Filters are advisory — re-verify the trust rule locally.
      if (ev.pubkey !== ownerPk) return;
      if (!ev.tags.some((t) => t[0] === "e" && t[1] === requestId)) return;
      if (APPROVE.has(ev.content.trim())) finish("approved");
      else if (DECLINE.has(ev.content.trim())) finish("declined");
    });
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

/** Production ConsentRelay over nostr-tools SimplePool. Untested by unit
 * tests (the seam above is what's tested); exercised in the e2e pass. */
export async function poolRelay(relayUrls: string[]): Promise<ConsentRelay> {
  const { SimplePool } = await import("nostr-tools/pool");
  const pool = new SimplePool();
  return {
    async publish(event) {
      await Promise.any(pool.publish(relayUrls, event));
    },
    subscribe(filter: Filter, onEvent) {
      const sub = pool.subscribeMany(relayUrls, [filter] as any, { onevent: onEvent });
      return () => sub.close();
    },
  };
}
