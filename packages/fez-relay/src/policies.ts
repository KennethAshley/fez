import type { StoredEvent } from "./relay.js";

/**
 * Relay policy hooks — bucket 3 of the Buzz-primitives roadmap: the one
 * job of Buzz's Postgres that client-side trust cannot replicate,
 * ENFORCEMENT AT INGEST. Every incoming event passes the pipeline before
 * storage/fanout; the first reject wins and the client gets a NIP-20
 * ["OK", id, false, reason]. Policies are strfry-plugin-shaped: operators
 * compose fez's built-ins below and/or bring their own (a --config module
 * can export any policy backed by any store — Supabase, Postgres,
 * whatever; fez doesn't care).
 *
 * Policies are OPTIONAL by design: a bare fez-relay is a dumb store and
 * client-side trust keeps working — that's fez's decentralized floor.
 * Policies are what let an operator run a Buzz-grade hosted community on
 * fez primitives.
 */

export interface PolicyContext {
  /** Query the relay's stored events (same matching semantics as REQ filters). */
  query(filter: Record<string, unknown>): StoredEvent[];
}

export type PolicyVerdict = { accept: true } | { accept: false; reason: string };

export interface RelayPolicy {
  name: string;
  onEvent(event: StoredEvent, ctx: PolicyContext): PolicyVerdict | Promise<PolicyVerdict>;
}

const ok: PolicyVerdict = { accept: true };
const reject = (reason: string): PolicyVerdict => ({ accept: false, reason });

// Fez community kinds (mirrors src/kinds.ts — duplicated by design: the
// relay package must stay dependency-free of the client).
const KIND_COMMUNITY = 47100;
const KIND_CHANNEL = 47101;
const KIND_MEMBERSHIP = 47102;
const tag = (e: StoredEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];

/**
 * Server-side mirror of fez's client trust rules, enforced at ingest:
 *
 * - 47100: first event for a community id fixes the creator — a later
 *   47100 with the same id from a different pubkey is rejected (identity
 *   squatting protection clients can't provide).
 * - 47101/47102: only the community creator may publish them.
 * - Any h-tagged event (channel messages, reactions, typing, drafts,
 *   thread summaries): the author must be in the channel's winning
 *   (latest creator-signed) 47102 membership.
 *
 * Everything else (agent metadata, attestations, observer frames, tasks)
 * passes through — not this policy's concern.
 */
export function membershipPolicy(): RelayPolicy {
  return {
    name: "membership",
    onEvent(event, ctx) {
      if (event.kind === KIND_COMMUNITY) {
        const id = tag(event, "d");
        if (!id) return reject("blocked: community event missing d tag");
        const existing = ctx
          .query({ kinds: [KIND_COMMUNITY], "#d": [id] })
          .sort((a, b) => a.created_at - b.created_at)[0];
        if (existing && existing.pubkey !== event.pubkey) {
          return reject("blocked: community id is owned by another pubkey");
        }
        return ok;
      }

      const creatorOf = (communityId: string): string | undefined =>
        ctx
          .query({ kinds: [KIND_COMMUNITY], "#d": [communityId] })
          .sort((a, b) => a.created_at - b.created_at)[0]?.pubkey;

      if (event.kind === KIND_CHANNEL || event.kind === KIND_MEMBERSHIP) {
        const communityId = tag(event, "c");
        if (!communityId) return reject("blocked: missing community tag");
        const creator = creatorOf(communityId);
        if (!creator) return reject("blocked: unknown community");
        if (creator !== event.pubkey) return reject("blocked: only the community creator may publish this");
        return ok;
      }

      const channelId = tag(event, "h");
      if (!channelId) return ok; // not channel-scoped — pass through

      const membership = ctx
        .query({ kinds: [KIND_MEMBERSHIP], "#d": [channelId] })
        .filter((m) => {
          const communityId = tag(m, "c");
          return communityId !== undefined && m.pubkey === creatorOf(communityId);
        })
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (!membership) return reject("blocked: unknown channel");
      const isMember = membership.tags.some((t) => t[0] === "p" && t[1] === event.pubkey);
      if (!isMember && membership.pubkey !== event.pubkey) {
        return reject("blocked: not a member of this channel");
      }
      return ok;
    },
  };
}

/** Accept only the listed kinds — everything else rejected at the door. */
export function kindWhitelistPolicy(kinds: number[]): RelayPolicy {
  const allowed = new Set(kinds);
  return {
    name: "kind-whitelist",
    onEvent(event) {
      return allowed.has(event.kind) ? ok : reject(`blocked: kind ${event.kind} not accepted here`);
    },
  };
}

/**
 * Sliding-window per-pubkey rate limit. Ephemeral kinds (20000-29999 —
 * typing heartbeats, streaming drafts) get their own higher budget:
 * they're chatty by design and never stored.
 */
export function rateLimitPolicy(opts?: { perMinute?: number; ephemeralPerMinute?: number }): RelayPolicy {
  const perMinute = opts?.perMinute ?? 120;
  const ephemeralPerMinute = opts?.ephemeralPerMinute ?? 600;
  const windows = new Map<string, number[]>();
  return {
    name: "rate-limit",
    onEvent(event) {
      const ephemeral = event.kind >= 20000 && event.kind < 30000;
      const key = `${event.pubkey}:${ephemeral ? "e" : "p"}`;
      const limit = ephemeral ? ephemeralPerMinute : perMinute;
      const now = Date.now();
      const hits = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
      if (hits.length >= limit) return reject("rate-limited: slow down");
      hits.push(now);
      windows.set(key, hits);
      return ok;
    },
  };
}

/** Registry for --policy flags on the CLI. */
export const builtinPolicies: Record<string, (arg?: string) => RelayPolicy> = {
  membership: () => membershipPolicy(),
  "rate-limit": (arg) => rateLimitPolicy(arg ? { perMinute: Number(arg) } : undefined),
  "kind-whitelist": (arg) =>
    kindWhitelistPolicy((arg ?? "").split(",").map(Number).filter(Number.isFinite)),
};
