import type { Filter } from "nostr-tools";
import type { SignedNostrEvent } from "./consent.js";
import { KIND_AGENT_METADATA } from "./consent.js";

/**
 * Who is here, by name — the name→pubkey half of paying an agent that
 * isn't yours. Pure so it can be tested without a relay: mcp.ts hands it
 * whatever the query returned and nothing else.
 */

/** Same window fez-client uses for the roster subscription. An agent
 * that hasn't announced in a week isn't running. */
export const ROSTER_WINDOW_S = 7 * 86400;

/**
 * UNSCOPED ON PURPOSE — do not add an `#h` filter here.
 *
 * 47000 announces carry NO tags at all (fez-acp/src/agent.ts publishes
 * `tags: []`), so a channel-scoped filter matches nothing and every
 * `@name` silently falls through to a raw send of the literal string.
 * fez-client queries this kind unscoped for the same reason: "one relay,
 * one workspace, so every channel and the single roster are simply what
 * is here" (fez-client/src/index.ts, resubscribe()).
 */
export function rosterFilter(nowMs: number = Date.now()): Filter {
  return {
    kinds: [KIND_AGENT_METADATA],
    since: Math.floor(nowMs / 1000) - ROSTER_WINDOW_S,
  };
}

/**
 * One entry per AGENT, not per event. 47000 is a regular kind: an agent
 * re-announces on every process start and the relay keeps all of them,
 * so an un-deduped roster reports the same agent two, five, twenty
 * times — and resolveRecipient, which refuses an ambiguous name, would
 * refuse a name that is not actually ambiguous.
 *
 * Newest `created_at` wins: the name in the latest announce is the name
 * that agent answers to now. Ties break on the later position in the
 * array, which is arbitrary but total — never a coin flip between two
 * different agents, since the key is the pubkey.
 */
export function rosterFromEvents(events: SignedNostrEvent[]): { name: string; pubkey: string }[] {
  const newest = new Map<string, { name: string; pubkey: string; at: number }>();
  for (const ev of events) {
    if (ev.kind !== KIND_AGENT_METADATA) continue;
    let name: string | undefined;
    try {
      name = (JSON.parse(ev.content) as { name?: string }).name;
    } catch {
      continue;
    }
    if (!name) continue;
    const seen = newest.get(ev.pubkey);
    if (seen && seen.at > ev.created_at) continue;
    newest.set(ev.pubkey, { name, pubkey: ev.pubkey, at: ev.created_at });
  }
  return [...newest.values()].map(({ name, pubkey }) => ({ name, pubkey }));
}
