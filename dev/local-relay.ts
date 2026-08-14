#!/usr/bin/env node
import { WebSocketServer, WebSocket } from "ws";
import { verifyEvent, matchFilter, type Event, type Filter } from "nostr-tools";

/**
 * Minimal in-memory Nostr relay for local dev/testing.
 *
 * Implements just enough of NIP-01 to exercise the Fez SDK without
 * depending on a public relay (which may drop/rate-limit unfamiliar
 * kinds like 47000-47099): EVENT, REQ, CLOSE, live subscriptions.
 * No persistence — state resets on restart.
 *
 * Run: npx tsx dev/local-relay.ts [port]
 * Point Fez at it: FEZ_RELAY=ws://localhost:7777 npx tsx src/cli.ts discover -r ws://localhost:7777
 */

const port = Number(process.argv[2] ?? process.env.PORT ?? 7777);

const events: Event[] = [];
type Sub = { subId: string; filters: Filter[]; ws: WebSocket };
const subs = new Map<string, Sub>(); // key: `${connId}:${subId}`

const wss = new WebSocketServer({ port });

let connCounter = 0;

wss.on("connection", (ws) => {
  const connId = String(connCounter++);
  console.log(`+ conn ${connId} (${wss.clients.size} total)`);

  ws.on("message", (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, ["NOTICE", "invalid JSON"]);
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "string") {
      return send(ws, ["NOTICE", "invalid message"]);
    }

    const [type, ...rest] = msg;

    if (type === "EVENT") {
      const event = rest[0] as Event;
      if (!verifyEvent(event)) {
        return send(ws, ["OK", event?.id ?? "", false, "invalid: signature verification failed"]);
      }
      events.push(event);
      console.log(`  EVENT kind=${event.kind} id=${event.id.slice(0, 8)} pubkey=${event.pubkey.slice(0, 8)}`);
      send(ws, ["OK", event.id, true, ""]);

      // Fan out to matching live subscriptions
      for (const sub of subs.values()) {
        if (sub.ws.readyState === WebSocket.OPEN && sub.filters.some((f) => matchFilter(f, event))) {
          send(sub.ws, ["EVENT", sub.subId, event]);
        }
      }
      return;
    }

    if (type === "REQ") {
      const subId = rest[0] as string;
      const filters = rest.slice(1) as Filter[];
      subs.set(`${connId}:${subId}`, { subId, filters, ws });

      const matches = events.filter((e) => filters.some((f) => matchFilter(f, e)));
      console.log(`  REQ sub=${subId} filters=${JSON.stringify(filters)} -> ${matches.length} stored match(es)`);
      for (const e of matches) send(ws, ["EVENT", subId, e]);
      send(ws, ["EOSE", subId]);
      return;
    }

    if (type === "CLOSE") {
      const subId = rest[0] as string;
      subs.delete(`${connId}:${subId}`);
      return;
    }
  });

  ws.on("close", () => {
    for (const key of subs.keys()) {
      if (key.startsWith(`${connId}:`)) subs.delete(key);
    }
    console.log(`- conn ${connId} (${wss.clients.size - 1} remaining)`);
  });
});

function send(ws: WebSocket, msg: unknown[]): void {
  ws.send(JSON.stringify(msg));
}

console.log(`🟢 Local Nostr relay listening on ws://localhost:${port}`);
console.log(`   In-memory only — events are lost on restart.`);
console.log(`   Press Ctrl+C to stop.`);

process.on("SIGINT", () => {
  wss.close();
  process.exit(0);
});
