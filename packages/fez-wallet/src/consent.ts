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
  timeoutMs: number,
  /** Finding #6: an in-flight consent wait must not outlive the MCP call
   * that started it. When the caller aborts, the wait ends right away —
   * a reaction that arrives after that point cannot flip the outcome. */
  signal?: AbortSignal
): Promise<"approved" | "declined" | "timeout" | "aborted"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: "approved" | "declined" | "timeout" | "aborted") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      signal?.removeEventListener("abort", onAbort);
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
    const onAbort = () => finish("aborted");
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Production ConsentRelay over nostr-tools SimplePool. Untested by unit
 * tests (the seam above is what's tested); exercised in the e2e pass.
 *
 * Memoized per sorted relay-URL set (finding #4): mcp.ts's deps() builds
 * fresh ToolDeps on every tool call, and a new SimplePool per consent
 * round-trip meant a new set of relay sockets every time. The pool
 * itself — the thing worth reusing — now persists across calls; only
 * the subscription made against it (unsub, returned per call) stays
 * scoped to that one request. */
const relayPools = new Map<string, ConsentRelay>();

export async function poolRelay(relayUrls: string[]): Promise<ConsentRelay> {
  const key = [...relayUrls].sort().join(",");
  const cached = relayPools.get(key);
  if (cached) return cached;

  const { SimplePool } = await import("nostr-tools/pool");
  const pool = new SimplePool();
  const relay: ConsentRelay = {
    async publish(event) {
      await Promise.any(pool.publish(relayUrls, event));
    },
    subscribe(filter: Filter, onEvent) {
      const sub = pool.subscribeMany(relayUrls, filter, { onevent: onEvent });
      return () => sub.close();
    },
  };
  relayPools.set(key, relay);
  return relay;
}
