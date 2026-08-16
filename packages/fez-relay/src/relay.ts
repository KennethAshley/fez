import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { verifyEvent } from "nostr-tools";
import type { PolicyContext, RelayPolicy } from "./policies.js";

/**
 * fez-relay — a NIP-01 relay with a policy pipeline (see policies.ts).
 * Promoted from dev/relay.ts once enforcement needed a real home.
 *
 * Deliberately protocol-pure: no TUI or fez-client imports. Any client
 * that speaks the nostr websocket protocol — the fez TUI today, a
 * Buzz-like GUI frontend later — talks to this identically.
 *
 * - EVENT: signature-verified (unless disabled), then the policy
 *   pipeline; first reject wins → ["OK", id, false, reason]. Accepted
 *   events fan out to matching subscriptions; non-ephemeral ones persist
 *   to an append-only JSONL store, reloaded on start.
 * - REQ/CLOSE: filter matching on kinds/authors/ids/since/until/limit and
 *   single-letter tag filters (#c, #h, #p, #d, ...).
 * - Ephemeral kinds (20000-29999) are relayed, never stored (NIP-01).
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

export interface RelayOptions {
  port: number;
  /** JSONL persistence path; omit for a purely in-memory relay. */
  store?: string;
  /** Verify event signatures/ids at ingest (default true). */
  verifySignatures?: boolean;
  policies?: RelayPolicy[];
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

  const events: StoredEvent[] = [];
  if (options.store) {
    try {
      for (const line of fs.readFileSync(options.store, "utf-8").split("\n")) {
        if (line.trim()) events.push(JSON.parse(line));
      }
      log(`📂 loaded ${events.length} events from ${options.store}`);
    } catch {
      // no store yet — fresh relay
    }
  }

  const ctx: PolicyContext = {
    query: (filter) => events.filter((e) => matches(e, filter)),
  };

  const subs = new Map<WebSocket, Map<string, Filter[]>>();
  const wss = new WebSocketServer({ port: options.port });

  wss.on("connection", (ws) => {
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

          if (!isEphemeral(event.kind)) {
            events.push(event);
            if (options.store) fs.appendFileSync(options.store, JSON.stringify(event) + "\n");
          }
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          for (const [client, clientSubs] of subs) {
            if (client.readyState !== WebSocket.OPEN) continue;
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
        subs.get(ws)?.set(subId, filters);
        for (const filter of filters) {
          const limit = typeof filter.limit === "number" ? filter.limit : Infinity;
          const matched = events.filter((e) => matches(e, filter)).slice(-limit);
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
