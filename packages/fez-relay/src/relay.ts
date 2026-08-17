import { WebSocketServer, WebSocket } from "ws";
import { verifyEvent } from "nostr-tools";
import type { PolicyContext, RelayPolicy } from "./policies.js";
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

export function matches(event: StoredEvent, filter: Filter): boolean {
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
  if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) return false;
  if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) return false;
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
  const events: StoredEvent[] = store ? store.load() : [];
  if (store) log(`📂 loaded ${events.length} events from ${options.store ?? "operator store"}`);

  // Ingest dedup: a replayed EVENT (client publish-retry, reconnect echo)
  // must not double-store or re-fan-out. Duplicates still get OK=true —
  // the event IS accepted, the client's retry succeeded (NIP-20 semantics).
  const known = new Set<string>(events.map((e) => e.id));
  const ephemeralSeen = new Set<string>();

  const ctx: PolicyContext = {
    query: (filter) => events.filter((e) => matches(e, filter)),
  };

  const subs = new Map<WebSocket, Map<string, Filter[]>>();
  const wss = new WebSocketServer({ port: options.port, maxPayload: limits.maxFrameBytes });

  wss.on("connection", (ws) => {
    if (subs.size >= limits.maxConns) {
      ws.close(1013, "too many connections"); // 1013 = Try Again Later
      return;
    }
    subs.set(ws, new Map());

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

          if (typeof event?.content === "string" && Buffer.byteLength(event.content) > limits.maxContentBytes) {
            ws.send(JSON.stringify(["OK", event.id ?? "", false, "invalid: content too large"]));
            return;
          }

          if (known.has(event.id) || ephemeralSeen.has(event.id)) {
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
          }
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
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
              if (filters.some((f) => matches(event, f))) {
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
          for (const event of matched) ws.send(JSON.stringify(["EVENT", subId, event]));
        }
        ws.send(JSON.stringify(["EOSE", subId]));
        return;
      }

      if (msg[0] === "CLOSE") {
        subs.get(ws)?.delete(msg[1] as string);
      }
    });

    ws.on("close", () => subs.delete(ws));
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
