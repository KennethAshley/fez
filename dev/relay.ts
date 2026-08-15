#!/usr/bin/env node
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";

/**
 * Minimal NIP-01 relay for local development — EVENT/REQ/CLOSE, filter
 * matching on kinds/authors/ids/since/limit and single-letter tag filters
 * (#c, #h, #p, #d, ...). No signature verification: it exists because
 * public relays typically reject fez's custom 471xx kinds, so communities
 * can't be exercised against them.
 *
 * Events persist to dev/relay-events.jsonl (append-only, reloaded on
 * start) — a relay restart used to orphan every community, since creator
 * rights live in relay events. Ephemeral kinds (20000-29999, e.g. typing
 * indicators) are relayed but never persisted, per NIP-01. Delete the
 * file for a clean slate.
 *
 * Run: npm run dev:relay   (ws://localhost:7777)
 */
const PORT = Number(process.env.PORT || 7777);
const STORE = new URL("./relay-events.jsonl", import.meta.url).pathname;

interface StoredEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

type Filter = Record<string, unknown>;

const isEphemeral = (kind: number) => kind >= 20000 && kind < 30000;

const events: StoredEvent[] = [];
try {
  for (const line of fs.readFileSync(STORE, "utf-8").split("\n")) {
    if (line.trim()) events.push(JSON.parse(line));
  }
  console.log(`📂 Loaded ${events.length} events from ${STORE}`);
} catch {
  // no store yet — fresh relay
}
const subs = new Map<WebSocket, Map<string, Filter[]>>();

function matches(event: StoredEvent, filter: Filter): boolean {
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

const wss = new WebSocketServer({ port: PORT });

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
      const event = msg[1] as StoredEvent;
      if (!isEphemeral(event.kind)) {
        events.push(event);
        fs.appendFileSync(STORE, JSON.stringify(event) + "\n");
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

console.log(`🔌 dev relay listening on ws://localhost:${PORT} (in-memory, no verification)`);
