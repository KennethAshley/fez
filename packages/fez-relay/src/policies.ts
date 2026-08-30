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

// Fez workspace kinds (mirrors src/kinds.ts — duplicated by design: the
// relay package must stay dependency-free of the client).
const KIND_COMMUNITY_RETIRED = 47100;
const KIND_CHANNEL = 47101;
const KIND_MEMBERSHIP = 47102;
const KIND_BAN_LIST = 30047;
const ROSTER_D = "roster";
const tag = (e: StoredEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];

/**
 * Server-side mirror of fez's client trust rules, enforced at ingest.
 *
 * A relay IS a workspace, so the whole trust chain reduces to one
 * question: **is this signed by the owner?** The owner is whoever the
 * relay advertises in its NIP-11 document, passed in here at startup —
 * no lookup, no per-community creator resolution, no chain to walk.
 *
 * - 47101 (channel), 47102 (roster), 30047 (bans): owner-signed only.
 * - Any h-tagged event (messages, reactions, typing, drafts, docs): the
 *   author must be on the workspace roster. Membership is workspace-wide
 *   — join the workspace, see every channel — so one roster answers for
 *   all of them.
 * - 47100 is retired and refused outright, so a stale client cannot
 *   recreate the layer that was removed.
 *
 * Without an owner the workspace is unclaimed and every governed kind is
 * refused. Failing closed here is deliberate: an unclaimed relay that
 * accepted rosters would let the first passer-by seize the workspace.
 *
 * Everything else (agent metadata, attestations, observer frames, tasks)
 * passes through — not this policy's concern.
 */
export function membershipPolicy(owner?: string): RelayPolicy {
  // Winning-roster cache — onDeliver runs per delivered event and a
  // linear scan per delivery would hurt. One roster per workspace now,
  // so this is a single slot rather than a map. Invalidated whenever a
  // fresh owner-signed 47102 is accepted (onEvent sees every ingest).
  let cachedRoster: StoredEvent | null | undefined;

  const winningRoster = (ctx: PolicyContext): StoredEvent | null => {
    if (cachedRoster !== undefined) return cachedRoster;
    cachedRoster = owner
      ? ctx
          .query({ kinds: [KIND_MEMBERSHIP], "#d": [ROSTER_D] })
          .filter((m) => m.pubkey === owner)
          .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0] ?? null
      : null;
    return cachedRoster;
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
      const roster = winningRoster(ctx);
      if (!roster) return false;
      // Workspace-wide: on the roster means every channel, which is the
      // point — an invited member lands and sees the whole place.
      return (
        roster.pubkey === ctx.authedPubkey ||
        roster.tags.some((t) => t[0] === "p" && t[1] === ctx.authedPubkey)
      );
    },

    onEvent(event, ctx) {
      if (event.kind === KIND_MEMBERSHIP) cachedRoster = undefined; // roster may have moved

      // The layer that was removed cannot be recreated by a stale client.
      if (event.kind === KIND_COMMUNITY_RETIRED) {
        return reject("blocked: kind 47100 is retired — a relay is a workspace");
      }

      // 30047 (bans/removed) authorization is moderationPolicy's job now —
      // it may be signed by the owner OR a current admin, which this policy
      // (owner-only) can't express. Channel + roster stay owner-only.
      const governed = event.kind === KIND_CHANNEL || event.kind === KIND_MEMBERSHIP;
      if (governed) {
        if (!owner) return reject("blocked: this workspace is unclaimed (no owner in NIP-11)");
        if (event.pubkey !== owner) return reject("blocked: only the workspace owner may publish this");
        if (event.kind === KIND_MEMBERSHIP && tag(event, "d") !== ROSTER_D) {
          // One roster per workspace. A per-channel d-tag is the old
          // model leaking through and would create a second authority.
          return reject(`blocked: the roster's d tag must be "${ROSTER_D}"`);
        }
        return ok;
      }

      const channelId = tag(event, "h");
      if (!channelId) return ok; // not channel-scoped — pass through

      const roster = winningRoster(ctx);
      if (!roster) return reject("blocked: this workspace has no roster yet");
      const isMember = roster.tags.some((t) => t[0] === "p" && t[1] === event.pubkey);
      if (!isMember && roster.pubkey !== event.pubkey) {
        return reject("blocked: not a member of this workspace");
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
 * decentralized): the latest kind-30047 ban list — signed by the owner OR
 * a current admin — is enforced at ingest (banned pubkeys can't write
 * channel content) and at delivery (an authed banned pubkey receives none).
 * Clients enforce the same list in their own trust rules — this policy is
 * the operator-grade backstop, like membershipPolicy.
 *
 * Admins are derived from the owner-signed roster (a `p` tag with role
 * "admin"), so authority still traces to the owner's signature: demote an
 * admin and their edicts stop being honored on the next roster.
 *
 * One list per workspace, keyed on BANS_D. Banned is banned everywhere in
 * the workspace, which is what "banned from the server" has always meant
 * to the person it happened to.
 */
export function moderationPolicy(owner?: string): RelayPolicy {
  const BANS_D = "bans";
  const REMOVED_D = "removed";
  let cachedBans: Map<string, number | undefined> | undefined;
  let cachedRemoved: Set<string> | undefined;
  let cachedAdmins: Set<string> | undefined;

  // Owner + everyone the owner's latest roster marks role "admin".
  const admins = (ctx: PolicyContext): Set<string> => {
    if (cachedAdmins) return cachedAdmins;
    const roster = owner
      ? ctx
          .query({ kinds: [KIND_MEMBERSHIP], "#d": [ROSTER_D] })
          .filter((e) => e.pubkey === owner)
          .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0]
      : undefined;
    const set = new Set<string>(owner ? [owner] : []);
    for (const t of roster?.tags ?? []) if (t[0] === "p" && t[1] && t[2] === "admin") set.add(t[1]);
    cachedAdmins = set;
    return set;
  };

  // pubkey -> until (unix seconds), or undefined for a permanent ban.
  const bans = (ctx: PolicyContext): Map<string, number | undefined> => {
    if (cachedBans) return cachedBans;
    const latest = ctx
      .query({ kinds: [KIND_BAN_LIST], "#d": [BANS_D] })
      .filter((e) => admins(ctx).has(e.pubkey))
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0];
    cachedBans = new Map(
      (latest?.tags ?? [])
        .filter((t) => t[0] === "p" && t[1])
        .map((t) => [t[1], t[2] ? Number(t[2]) : undefined] as const)
    );
    return cachedBans;
  };

  // A timeout (until set) is a ban only until it expires; the list is cached
  // but expiry is evaluated live, so nothing has to re-publish to lift it.
  const isBanned = (pk: string, ctx: PolicyContext): boolean => {
    const m = bans(ctx);
    if (!m.has(pk)) return false;
    const until = m.get(pk);
    return until === undefined || Math.floor(Date.now() / 1000) < until;
  };

  // Event-ids an owner/admin has withheld. Reversible: drop the id from the
  // list and the event is served again — the bytes were never deleted.
  const removed = (ctx: PolicyContext): Set<string> => {
    if (cachedRemoved) return cachedRemoved;
    const latest = ctx
      .query({ kinds: [KIND_BAN_LIST], "#d": [REMOVED_D] })
      .filter((e) => admins(ctx).has(e.pubkey))
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0];
    cachedRemoved = new Set((latest?.tags ?? []).filter((t) => t[0] === "e" && t[1]).map((t) => t[1]));
    return cachedRemoved;
  };

  return {
    name: "moderation",

    onEvent(event, ctx) {
      // The roster is the admin set; if it moved, both derivations are stale.
      if (event.kind === KIND_MEMBERSHIP) {
        cachedAdmins = undefined; // admin set moved — both derivations are stale
        cachedBans = undefined;
        cachedRemoved = undefined;
        return ok;
      }
      if (event.kind === KIND_BAN_LIST) {
        // Only the owner or a current admin may write an edict (bans or removes).
        if (!admins(ctx).has(event.pubkey)) {
          return reject("blocked: not authorized to moderate this workspace");
        }
        if (tag(event, "d") === REMOVED_D) cachedRemoved = undefined;
        else cachedBans = undefined;
        return ok;
      }
      // A withheld event may not be re-injected under its own id.
      if (removed(ctx).has(event.id)) return reject("blocked: this message was removed by a moderator");
      // Channel-scoped writes are what a ban withholds — the workspace
      // is the scope, so the h tag is the hook.
      if (!tag(event, "h")) return ok;
      if (isBanned(event.pubkey, ctx)) return reject("blocked: banned from this workspace");
      return ok;
    },

    onDeliver(event, ctx) {
      if (removed(ctx).has(event.id)) return false; // withheld from every reader, reversibly
      if (!tag(event, "h") || !ctx.authedPubkey) return true; // unauthed read privacy is membershipPolicy's job
      return !isBanned(ctx.authedPubkey, ctx);
    },
  };
}

/** Registry for --policy flags on the CLI. */
export const builtinPolicies: Record<string, (arg?: string) => RelayPolicy> = {
  // `--policy membership:<ownerHex>` — the owner is the whole trust root
  // now, so it is an argument rather than something looked up on the wire.
  membership: (arg) => membershipPolicy(arg),
  "rate-limit": (arg) => rateLimitPolicy(arg ? { perMinute: Number(arg) } : undefined),
  "kind-whitelist": (arg) =>
    kindWhitelistPolicy((arg ?? "").split(",").map(Number).filter(Number.isFinite)),
  "created-at-fence": (arg) =>
    createdAtFencePolicy(arg ? { maxDriftS: Number(arg) } : undefined),
  moderation: (arg) => moderationPolicy(arg),
};
