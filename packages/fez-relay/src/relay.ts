import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { verifyEvent } from "nostr-tools";
import type { DeliverContext, PolicyContext, RelayPolicy } from "./policies.js";
import { storeForPath, type EventStore } from "./stores.js";

/**
 * fez-relay — a NIP-01 relay with a policy pipeline (see policies.ts).
 * Promoted from dev/relay.ts once enforcement needed a real home.
 *
 * Deliberately protocol-pure: no TUI or fez-client imports. Any client
 * that speaks the nostr websocket protocol — the fez TUI today, a
 * Buzz-like GUI frontend later — talks to this identically.
 *
 * - EVENT: frame/content size caps → duplicate-id check → signature
 *   verification (unless disabled) → the policy pipeline; first reject
 *   wins → ["OK", id, false, reason]. Accepted events fan out to matching
 *   subscriptions; non-ephemeral ones persist to an append-only JSONL
 *   store, reloaded on start.
 * - REQ/CLOSE: filter matching on kinds/authors/ids/since/until/limit and
 *   single-letter tag filters (#c, #h, #p, #d, ...). Stored matches are
 *   served newest-first per NIP-01, limit clamped.
 * - Ephemeral kinds (20000-29999) are relayed, never stored (NIP-01).
 * - Resource ceilings (Buzz-proven defaults, see RelayLimits): connection
 *   cap, per-connection subscription cap, filters-per-REQ cap, and a
 *   slow-consumer disconnect — a client whose socket buffer backs up is
 *   terminated and recovers via its own reconnect+resubscribe.
 */

export interface StoredEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

type Filter = Record<string, unknown>;

/**
 * Structural resource ceilings. Defaults are Buzz's production numbers —
 * these are correctness/DoS floors that belong in core, unlike the
 * pluggable *judgment* calls in policies.ts.
 */
export interface RelayLimits {
  /** Max EVENT content field size in bytes (default 256KB). */
  maxContentBytes?: number;
  /** Max inbound websocket frame size in bytes (default 512KB). */
  maxFrameBytes?: number;
  /** Max concurrent subscriptions per connection (default 1024). */
  maxSubsPerConn?: number;
  /** Max filters accepted per REQ (default 10). */
  maxFiltersPerReq?: number;
  /** REQ `limit` values are clamped to this (default 1000). */
  limitClamp?: number;
  /** Max concurrent connections (default 1024). */
  maxConns?: number;
  /** Outbound buffer size at which a slow consumer is disconnected (default 8MB). */
  maxBufferedBytes?: number;
}

const LIMIT_DEFAULTS: Required<RelayLimits> = {
  maxContentBytes: 256 * 1024,
  maxFrameBytes: 512 * 1024,
  maxSubsPerConn: 1024,
  maxFiltersPerReq: 10,
  limitClamp: 1000,
  maxConns: 1024,
  maxBufferedBytes: 8 * 1024 * 1024,
};

export interface RelayOptions {
  port: number;
  /** Persistence path (.jsonl default; .db/.sqlite → SQLite). Omit for in-memory. */
  store?: string;
  /** Bring-your-own durability (overrides `store`) — see stores.ts EventStore. */
  eventStore?: EventStore;
  /** Verify event signatures/ids at ingest (default true). */
  verifySignatures?: boolean;
  policies?: RelayPolicy[];
  limits?: RelayLimits;
  log?: (line: string) => void;
}

const isEphemeral = (kind: number) => kind >= 20000 && kind < 30000;

/**
 * Kinds a NIP-09 deletion may mask from REQ replies (author-match only).
 * Deliberately excludes the community trust chain (47100-47102) — masking
 * a roster event would resurrect an older roster, so those are immutable
 * here regardless of who signs the deletion. Creator-moderation deletes
 * of other people's messages are a CLIENT trust rule (tombstones); the
 * relay masks only what NIP-09 itself authorizes: your own events.
 */
const DELETABLE_KINDS = new Set([7, 47103, 40003, 40004, 40005]);

// NIP-16/33: replaceable kinds keep only the latest per (pubkey, kind[, d]).
// Fez's chattiest kinds live here — 30078 read state publishes on every
// channel view, 39005 summaries on every thread change; without this the
// index (and boot replay) grows without bound. Buzz spent five migrations
// on this exact class.
const isReplaceable = (kind: number) =>
  kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
const isParamReplaceable = (kind: number) => kind >= 30000 && kind < 40000;

function replaceKey(event: StoredEvent): string | undefined {
  if (isReplaceable(event.kind)) return `${event.kind}:${event.pubkey}`;
  if (isParamReplaceable(event.kind)) {
    const d = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    return `${event.kind}:${event.pubkey}:${d}`;
  }
  return undefined;
}

/** Latest wins; NIP-01 tie-break: same created_at → lowest id survives. */
function newerWins(a: StoredEvent, b: StoredEvent): StoredEvent {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? a : b;
  return a.id < b.id ? a : b;
}

function applyCompaction(list: StoredEvent[]): StoredEvent[] {
  const winners = new Map<string, StoredEvent>();
  let hasReplaceable = false;
  for (const event of list) {
    const key = replaceKey(event);
    if (!key) continue;
    hasReplaceable = true;
    const current = winners.get(key);
    winners.set(key, current ? newerWins(current, event) : event);
  }
  if (!hasReplaceable) return list;
  return list.filter((e) => {
    const key = replaceKey(e);
    return !key || winners.get(key) === e;
  });
}

function applyDeletions(list: StoredEvent[], maskedOut?: Set<string>): StoredEvent[] {
  const byId = new Map(list.map((e) => [e.id, e]));
  const masked = maskedOut ?? new Set<string>();
  for (const event of list) {
    if (event.kind !== 5) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "e" || !tag[1]) continue;
      const target = byId.get(tag[1]);
      if (target && target.pubkey === event.pubkey && DELETABLE_KINDS.has(target.kind)) {
        masked.add(tag[1]);
      }
    }
  }
  return masked.size ? list.filter((e) => !masked.has(e.id)) : list;
}

export function matches(event: StoredEvent, filter: Filter): boolean {
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
  if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) return false;
  if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) return false;
  // NIP-50: `search` — case-insensitive AND over whitespace tokens. The
  // in-RAM index IS the search index ("the write is the index" — Buzz's
  // decision, minus their Postgres). Results stay candidates, never
  // authority: they flow through the same onDeliver read gate and client
  // trust re-filtering as any other REQ.
  if (typeof filter.search === "string" && filter.search.trim()) {
    const haystack = event.content.toLowerCase();
    for (const token of filter.search.toLowerCase().split(/\s+/)) {
      if (token && !haystack.includes(token)) return false;
    }
  }
  if (typeof filter.since === "number" && event.created_at < filter.since) return false;
  if (typeof filter.until === "number" && event.created_at > filter.until) return false;
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("#") && Array.isArray(value)) {
      const tagName = key.slice(1);
      const tagValues = event.tags.filter((t) => t[0] === tagName).map((t) => t[1]);
      if (!value.some((v) => tagValues.includes(v as string))) return false;
    }
  }
  return true;
}

export interface RelayHandle {
  close(): void;
  readonly eventCount: number;
}

export function startRelay(options: RelayOptions): RelayHandle {
  const log = options.log ?? ((line: string) => console.log(line));
  const verify = options.verifySignatures !== false;
  const policies = options.policies ?? [];
  const limits = { ...LIMIT_DEFAULTS, ...options.limits };

  const store = options.eventStore ?? (options.store ? storeForPath(options.store) : undefined);
  const loaded: StoredEvent[] = store ? store.load() : [];
  // Ingest dedup: a replayed EVENT (client publish-retry, reconnect echo)
  // must not double-store or re-fan-out. Duplicates still get OK=true —
  // the event IS accepted, the client's retry succeeded (NIP-20 semantics).
  // Seeded BEFORE deletion masking: a masked event must stay known, or a
  // replay would resurrect it.
  const known = new Set<string>(loaded.map((e) => e.id));
  // Ids masked by a valid deletion stay refused forever — even after a
  // store rewrite forgets the original (a replayed deleted event must not
  // resurrect).
  const tombstoned = new Set<string>();
  const events: StoredEvent[] = applyCompaction(applyDeletions(loaded, tombstoned));
  if (store) {
    const dropped = loaded.length - events.length;
    log(`📂 loaded ${events.length} events from ${options.store ?? "operator store"}${dropped ? ` (${dropped} compacted/masked)` : ""}`);
    // Rewrite the store when the append-only history has accumulated
    // meaningful dead weight — boot replay cost stays bounded.
    if (store.compact && dropped > 100 && dropped > loaded.length / 5) {
      try {
        store.compact(events);
        log(`🗜 store compacted: ${loaded.length} → ${events.length} events`);
      } catch (err) {
        log(`⚠️ store compaction failed (continuing on full history): ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  const ephemeralSeen = new Set<string>();

  const ctx: PolicyContext = {
    query: (filter) => events.filter((e) => matches(e, filter)),
  };

  const subs = new Map<WebSocket, Map<string, Filter[]>>();
  // NIP-42 connection identity: challenge issued at connect, pubkey set
  // once a valid kind-22242 AUTH lands. Read-side policies key on it.
  const connAuth = new Map<WebSocket, { challenge: string; authedPubkey?: string }>();
  const readGated = policies.some((p) => p.onDeliver);

  /** First onDeliver false wins — the event is withheld from this connection. */
  const deliverable = (event: StoredEvent, ws: WebSocket): boolean => {
    if (!readGated) return true;
    const deliverCtx: DeliverContext = { ...ctx, authedPubkey: connAuth.get(ws)?.authedPubkey };
    for (const policy of policies) {
      try {
        if (policy.onDeliver && !policy.onDeliver(event, deliverCtx)) return false;
      } catch (err) {
        log(`⚠️ policy ${policy.name} onDeliver threw (withholding): ${err instanceof Error ? err.message : err}`);
        return false; // fail closed on the read side
      }
    }
    return true;
  };

  const wss = new WebSocketServer({ port: options.port, maxPayload: limits.maxFrameBytes });

  wss.on("connection", (ws) => {
    if (subs.size >= limits.maxConns) {
      ws.close(1013, "too many connections"); // 1013 = Try Again Later
      return;
    }
    subs.set(ws, new Map());
    const challenge = randomBytes(16).toString("hex");
    connAuth.set(ws, { challenge });
    ws.send(JSON.stringify(["AUTH", challenge]));

    ws.on("message", (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg[0] === "EVENT") {
        void (async () => {
          const event = msg[1] as StoredEvent;
          let suppressFanout = false;

          if (typeof event?.content === "string" && Buffer.byteLength(event.content) > limits.maxContentBytes) {
            ws.send(JSON.stringify(["OK", event.id ?? "", false, "invalid: content too large"]));
            return;
          }

          if (known.has(event.id) || ephemeralSeen.has(event.id) || tombstoned.has(event.id)) {
            ws.send(JSON.stringify(["OK", event.id, true, "duplicate: already have this event"]));
            return;
          }

          if (verify && !verifyEvent(event)) {
            ws.send(JSON.stringify(["OK", event.id, false, "invalid: bad signature"]));
            return;
          }

          for (const policy of policies) {
            let verdict;
            try {
              verdict = await policy.onEvent(event, ctx);
            } catch (err) {
              verdict = { accept: false as const, reason: `error: policy ${policy.name} failed` };
              log(`⚠️ policy ${policy.name} threw: ${err instanceof Error ? err.message : err}`);
            }
            if (!verdict.accept) {
              ws.send(JSON.stringify(["OK", event.id, false, verdict.reason]));
              log(`⛔ ${policy.name} rejected kind ${event.kind} from ${event.pubkey.slice(0, 8)}…: ${verdict.reason}`);
              return;
            }
          }

          if (isEphemeral(event.kind)) {
            // Ephemerals are never stored, so their dedup memory is bounded
            // separately (typing/draft heartbeats would grow `known` forever).
            ephemeralSeen.add(event.id);
            if (ephemeralSeen.size > 10_000) {
              let i = 0;
              for (const id of ephemeralSeen) {
                ephemeralSeen.delete(id);
                if (++i >= 5_000) break;
              }
            }
          } else {
            known.add(event.id);
            events.push(event);
            store?.append(event);
            // NIP-09: an accepted deletion masks the author's own events
            // from future REQs immediately (the JSONL keeps both — masking
            // re-derives at load). The kind 5 itself still stores + fans
            // out so clients can tombstone.
            if (event.kind === 5) {
              for (const tag of event.tags) {
                if (tag[0] !== "e" || !tag[1]) continue;
                const idx = events.findIndex((e) => e.id === tag[1]);
                if (idx >= 0 && events[idx].pubkey === event.pubkey && DELETABLE_KINDS.has(events[idx].kind)) {
                  tombstoned.add(tag[1]);
                  events.splice(idx, 1);
                }
              }
            }
            // Replaceable latest-wins at ingest: evict the loser from the
            // serving index (the append-only store keeps history; the
            // boot-time compaction pass re-derives the same answer).
            const key = replaceKey(event);
            if (key) {
              const rivalIdx = events.findIndex((e) => e !== event && replaceKey(e) === key);
              if (rivalIdx >= 0) {
                const rival = events[rivalIdx];
                if (newerWins(rival, event) === rival) {
                  events.pop(); // the new arrival lost; rival keeps serving
                  suppressFanout = true; // don't push a stale version to live subs
                } else {
                  events.splice(rivalIdx, 1);
                }
              }
            }
          }
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          if (suppressFanout) return;
          for (const [client, clientSubs] of subs) {
            if (client.readyState !== WebSocket.OPEN) continue;
            // Slow-consumer fence: a client that stops draining its socket
            // would buffer unboundedly here. Cut it loose — clients own
            // reconnect+resubscribe, so recovery is clean (Buzz's decision:
            // disconnect beats silent per-event drops, which desync state).
            if (client.bufferedAmount > limits.maxBufferedBytes) {
              log(`⚠️ dropping slow consumer (${Math.round(client.bufferedAmount / 1024)}KB buffered)`);
              client.terminate();
              continue;
            }
            for (const [subId, filters] of clientSubs) {
              if (filters.some((f) => matches(event, f)) && deliverable(event, client)) {
                client.send(JSON.stringify(["EVENT", subId, event]));
              }
            }
          }
        })();
        return;
      }

      if (msg[0] === "REQ") {
        const subId = msg[1] as string;
        const filters = msg.slice(2) as Filter[];
        const clientSubs = subs.get(ws);
        if (!clientSubs) return;
        if (filters.length > limits.maxFiltersPerReq) {
          ws.send(JSON.stringify(["CLOSED", subId, `error: too many filters (max ${limits.maxFiltersPerReq})`]));
          return;
        }
        if (!clientSubs.has(subId) && clientSubs.size >= limits.maxSubsPerConn) {
          ws.send(JSON.stringify(["CLOSED", subId, `error: too many subscriptions (max ${limits.maxSubsPerConn})`]));
          return;
        }
        clientSubs.set(subId, filters);
        let withheldUnauthed = false;
        for (const filter of filters) {
          const limit = Math.min(
            typeof filter.limit === "number" ? filter.limit : Infinity,
            limits.limitClamp
          );
          // NIP-01: `limit` selects the LATEST events — newest-first by
          // created_at (id tiebreak for determinism), not insertion order.
          const matched = events
            .filter((e) => matches(e, filter))
            .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
            .slice(0, limit);
          for (const event of matched) {
            if (!deliverable(event, ws)) {
              if (!connAuth.get(ws)?.authedPubkey) withheldUnauthed = true;
              continue;
            }
            ws.send(JSON.stringify(["EVENT", subId, event]));
          }
        }
        // NIP-42: content was withheld from an UNAUTHED connection —
        // close the sub with auth-required so the client can AUTH and
        // resubscribe (nostr-tools does this automatically). An authed
        // connection that's simply not allowed gets a normal EOSE.
        if (withheldUnauthed) {
          clientSubs.delete(subId);
          ws.send(JSON.stringify(["CLOSED", subId, "auth-required: read access is membership-gated"]));
          return;
        }
        ws.send(JSON.stringify(["EOSE", subId]));
        return;
      }

      if (msg[0] === "CLOSE") {
        subs.get(ws)?.delete(msg[1] as string);
        return;
      }

      if (msg[0] === "AUTH") {
        const event = msg[1] as StoredEvent;
        const state = connAuth.get(ws);
        const now = Math.floor(Date.now() / 1000);
        const challengeTag = event?.tags?.find((t) => t[0] === "challenge")?.[1];
        if (
          !state ||
          event?.kind !== 22242 ||
          challengeTag !== state.challenge ||
          Math.abs(event.created_at - now) > 600 ||
          !verifyEvent(event)
        ) {
          ws.send(JSON.stringify(["OK", event?.id ?? "", false, "invalid: auth event rejected"]));
          return;
        }
        state.authedPubkey = event.pubkey;
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
    });

    ws.on("close", () => {
      subs.delete(ws);
      connAuth.delete(ws);
    });
  });

  const policyNames = policies.map((p) => p.name).join(", ") || "none (dumb store)";
  log(`🔌 fez-relay on ws://localhost:${options.port} · verify: ${verify ? "on" : "off"} · policies: ${policyNames}`);

  return {
    close: () => wss.close(),
    get eventCount() {
      return events.length;
    },
  };
}

export { type EventStore, JsonlEventStore, SqliteEventStore, storeForPath } from "./stores.js";
