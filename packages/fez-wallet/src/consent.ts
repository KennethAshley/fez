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

/**
 * Production ConsentRelay over the fleet's RelayConnection rather than a
 * raw SimplePool: membership-gated relays (the Buzz model fez-relay
 * enforces) withhold READS from unauthenticated connections, so a pool
 * that never answers the NIP-42 challenge subscribes to silence — the
 * owner's ✅ exists on the relay and the wallet never sees it (found
 * live in the testnet e2e). RelayConnection already speaks NIP-42 via
 * authSigner; the agent's nostr key signs the 22242.
 */
export async function poolRelay(relayUrls: string[], authSecretHex?: string): Promise<ConsentRelay> {
  const key = [...relayUrls].sort().join(",") + (authSecretHex ? ":authed" : "");
  const cached = relayPools.get(key);
  if (cached) return cached;

  const { RelayConnection } = await import("@fezchat/protocol");
  const { finalizeEvent } = await import("nostr-tools/pure");
  const { hexToBytes } = await import("nostr-tools/utils");
  const conn = new RelayConnection({
    urls: relayUrls,
    authSigner: authSecretHex
      ? async (template: { kind: number; created_at: number; tags: string[][]; content: string }) =>
          finalizeEvent(template, hexToBytes(authSecretHex))
      : undefined,
  });
  await conn.connect();
  const relay: ConsentRelay = {
    async publish(event) {
      await conn.publish(event as never);
    },
    subscribe(filter: Filter, onEvent) {
      return conn.subscribe([filter] as never, onEvent as never);
    },
  };
  relayPools.set(key, relay);
  return relay;
}
