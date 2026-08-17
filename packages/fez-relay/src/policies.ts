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

/** Read-side context: who is asking. authedPubkey comes from NIP-42. */
export interface DeliverContext extends PolicyContext {
  /** NIP-42-proven pubkey of the subscriber's connection, if they authed. */
  authedPubkey?: string;
}

export type PolicyVerdict = { accept: true } | { accept: false; reason: string };

export interface RelayPolicy {
  name: string;
  onEvent(event: StoredEvent, ctx: PolicyContext): PolicyVerdict | Promise<PolicyVerdict>;
  /**
   * Read-side gate (GAPS 2.3 — Buzz's "a registered subscription is never
   * sufficient for delivery"): called for every event about to be served
   * to a connection, on REQ replay AND live fanout. Return false to
   * withhold. MUST be synchronous — it sits on the delivery hot path.
   * Absent = deliver everything (the dumb-store floor).
   */
  onDeliver?(event: StoredEvent, ctx: DeliverContext): boolean;
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
  // Winning-roster cache — onDeliver runs per delivered event, and a
  // linear scan per delivery would hurt. Invalidated whenever a fresh
  // 47102 for the channel is accepted (onEvent sees every ingest).
  const rosterCache = new Map<string, StoredEvent | null>();

  const winningRoster = (ctx: PolicyContext, channelId: string): StoredEvent | null => {
    const cached = rosterCache.get(channelId);
    if (cached !== undefined) return cached;
    const creatorOf = (communityId: string): string | undefined =>
      ctx
        .query({ kinds: [KIND_COMMUNITY], "#d": [communityId] })
        .sort((a, b) => a.created_at - b.created_at)[0]?.pubkey;
    const winner =
      ctx
        .query({ kinds: [KIND_MEMBERSHIP], "#d": [channelId] })
        .filter((m) => {
          const communityId = m.tags.find((t) => t[0] === "c")?.[1];
          return communityId !== undefined && m.pubkey === creatorOf(communityId);
        })
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0] ?? null;
    rosterCache.set(channelId, winner);
    return winner;
  };

  return {
    name: "membership",

    /**
     * Read side: h-tagged content (messages, reactions, drafts, docs …)
     * is delivered only to NIP-42-authed members of the channel (or its
     * roster signer). This is the one enforcement clients cannot provide
     * for each other — a non-member's subscription otherwise receives
     * plaintext they'd merely decline to render. Fail closed: unknown
     * channel or unauthed connection sees nothing h-tagged.
     */
    onDeliver(event, ctx) {
      const channelId = tag(event, "h");
      if (!channelId) return true; // not channel-scoped — public
      if (!ctx.authedPubkey) return false;
      const roster = winningRoster(ctx, channelId);
      if (!roster) return false;
      return (
        roster.pubkey === ctx.authedPubkey ||
        roster.tags.some((t) => t[0] === "p" && t[1] === ctx.authedPubkey)
      );
    },

    onEvent(event, ctx) {
      if (event.kind === KIND_MEMBERSHIP || event.kind === KIND_COMMUNITY) {
        const d = tag(event, "d");
        if (d) rosterCache.delete(d); // roster (or its creator chain) may change
        if (event.kind === KIND_COMMUNITY) rosterCache.clear(); // creator resolution feeds every roster
      }
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

/**
 * created_at drift fence (Buzz ingest.rs ±900s decision). Every client-side
 * latest-wins derivation — membership rosters, edits, read state — trusts
 * created_at, so a backdated or future-dated event is fez's equivalent of a
 * database-integrity attack. Fence it at the door.
 *
 * The asymmetric exemption matters: NIP-17 gift wraps (kind 1059) carry
 * DELIBERATELY backdated created_at (fuzzed up to 2 days) — the past fence
 * must not see them. The future fence applies to everything; nothing
 * legitimate is stamped ahead of the relay's clock.
 */
export function createdAtFencePolicy(opts?: { maxDriftS?: number; pastExemptKinds?: number[] }): RelayPolicy {
  const maxDriftS = opts?.maxDriftS ?? 900;
  const pastExempt = new Set(opts?.pastExemptKinds ?? [1059]);
  return {
    name: "created-at-fence",
    onEvent(event) {
      const now = Math.floor(Date.now() / 1000);
      if (event.created_at > now + maxDriftS) {
        return reject("invalid: created_at too far in the future");
      }
      if (!pastExempt.has(event.kind) && event.created_at < now - maxDriftS) {
        return reject("invalid: created_at too far in the past");
      }
      return ok;
    },
  };
}

/**
 * Moderation enforcement (Buzz's 9040-44 "bans bite at the seam",
 * decentralized): the community creator's latest kind-30047 ban list is
 * enforced at ingest (banned pubkeys can't write community-tagged events)
 * and at delivery (an authed banned pubkey receives no community
 * content). Clients enforce the same list in their own trust rules —
 * this policy is the operator-grade backstop, like membershipPolicy.
 */
export function moderationPolicy(): RelayPolicy {
  const KIND_BAN_LIST = 30047;
  const banCache = new Map<string, Set<string>>();

  const bansFor = (ctx: PolicyContext, communityId: string): Set<string> => {
    const cached = banCache.get(communityId);
    if (cached) return cached;
    const creator = ctx
      .query({ kinds: [KIND_COMMUNITY], "#d": [communityId] })
      .sort((a, b) => a.created_at - b.created_at)[0]?.pubkey;
    const latest = ctx
      .query({ kinds: [KIND_BAN_LIST], "#d": [communityId] })
      .filter((e) => e.pubkey === creator)
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0];
    const banned = new Set(latest?.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]) ?? []);
    banCache.set(communityId, banned);
    return banned;
  };

  return {
    name: "moderation",

    onEvent(event, ctx) {
      if (event.kind === KIND_BAN_LIST) {
        const communityId = tag(event, "d");
        if (!communityId) return reject("blocked: ban list missing community d tag");
        const creator = ctx
          .query({ kinds: [KIND_COMMUNITY], "#d": [communityId] })
          .sort((a, b) => a.created_at - b.created_at)[0]?.pubkey;
        if (!creator) return reject("blocked: unknown community");
        if (creator !== event.pubkey) return reject("blocked: only the community creator may publish the ban list");
        banCache.delete(communityId);
        return ok;
      }
      const communityId = tag(event, "c");
      if (!communityId) return ok;
      if (bansFor(ctx, communityId).has(event.pubkey)) {
        return reject("blocked: banned from this community");
      }
      return ok;
    },

    onDeliver(event, ctx) {
      const communityId = tag(event, "c");
      if (!communityId || !ctx.authedPubkey) return true; // unauthed read privacy is membershipPolicy's job
      return !bansFor(ctx, communityId).has(ctx.authedPubkey);
    },
  };
}

/** Registry for --policy flags on the CLI. */
export const builtinPolicies: Record<string, (arg?: string) => RelayPolicy> = {
  membership: () => membershipPolicy(),
  "rate-limit": (arg) => rateLimitPolicy(arg ? { perMinute: Number(arg) } : undefined),
  "kind-whitelist": (arg) =>
    kindWhitelistPolicy((arg ?? "").split(",").map(Number).filter(Number.isFinite)),
  "created-at-fence": (arg) =>
    createdAtFencePolicy(arg ? { maxDriftS: Number(arg) } : undefined),
  moderation: () => moderationPolicy(),
};
