import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocketServer, WebSocket as WsSocket } from "ws";
import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools/pure";
import { matchFilter, type Event, type Filter } from "nostr-tools";
import { RelayConnection } from "@fezchat/protocol";

/**
 * Reconnect gate — the wire-level survival guarantees:
 * a standing subscription outlives a dropped socket, backdated stragglers
 * are recovered by the skew backfill, publishes retry across the drop, and
 * policy rejections fail fast instead of retrying.
 *
 * The relay here is a killable in-process NIP-01 subset (dev/local-relay.ts
 * distilled): events persist across socket drops, so "the world kept moving
 * while we were gone" is simulated by terminating only the client's sockets.
 */

const PORT = 7791;

class MiniRelay {
  events: Event[] = [];
  private wss?: WebSocketServer;
  private subs = new Map<string, { subId: string; filters: Filter[]; ws: WsSocket }>();
  private connCounter = 0;
  /** kinds the relay rejects with OK=false, to test the no-retry path */
  blockedKinds = new Set<number>();

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: PORT }, resolve);
      this.wss.on("connection", (ws) => {
        const connId = String(this.connCounter++);
        ws.on("message", (raw) => {
          let msg: unknown[];
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          const [type, ...rest] = msg as [string, ...unknown[]];
          if (type === "EVENT") {
            const event = rest[0] as Event;
            if (!verifyEvent(event)) return;
            if (this.blockedKinds.has(event.kind)) {
              ws.send(JSON.stringify(["OK", event.id, false, "blocked: kind not allowed"]));
              return;
            }
            this.events.push(event);
            ws.send(JSON.stringify(["OK", event.id, true, ""]));
            for (const sub of this.subs.values()) {
              if (sub.ws.readyState === WsSocket.OPEN && sub.filters.some((f) => matchFilter(f, event))) {
                sub.ws.send(JSON.stringify(["EVENT", sub.subId, event]));
              }
            }
          } else if (type === "REQ") {
            const subId = rest[0] as string;
            const filters = rest.slice(1) as Filter[];
            this.subs.set(`${connId}:${subId}`, { subId, filters, ws });
            for (const e of this.events.filter((e) => filters.some((f) => matchFilter(f, e)))) {
              ws.send(JSON.stringify(["EVENT", subId, e]));
            }
            ws.send(JSON.stringify(["EOSE", subId]));
          } else if (type === "CLOSE") {
            this.subs.delete(`${connId}:${rest[0] as string}`);
          }
        });
        ws.on("close", () => {
          for (const key of this.subs.keys()) {
            if (key.startsWith(`${connId}:`)) this.subs.delete(key);
          }
        });
      });
    });
  }

  /** Sever every client socket; the relay itself stays up (network-blip simulation). */
  dropClients(): void {
    this.wss?.clients.forEach((c) => c.terminate());
    this.subs.clear();
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.dropClients();
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
  }
}

const sk = generateSecretKey();

/** Publish via a throwaway raw socket — "someone else spoke while we were gone". */
function sideChannelPublish(template: { kind: number; content: string; created_at?: number }): Promise<Event> {
  const event = finalizeEvent(
    {
      kind: template.kind,
      created_at: template.created_at ?? Math.floor(Date.now() / 1000),
      tags: [],
      content: template.content,
    },
    sk
  );
  return new Promise((resolve, reject) => {
    const ws = new WsSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("side-channel publish timed out"));
    }, 3000);
    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg[0] === "OK" && msg[1] === event.id) {
        clearTimeout(timer);
        ws.close();
        resolve(event);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (predicate()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 100);
  });
}

const relay = new MiniRelay();
let conn: RelayConnection;
const received: Event[] = [];
let disconnects = 0;
let connects = 0;

beforeAll(async () => {
  await relay.start();
  conn = new RelayConnection({
    url: `ws://127.0.0.1:${PORT}`,
    watchdogMs: 200, // fast liveness polling so tests run in seconds
    onConnect: () => connects++,
    onDisconnect: () => disconnects++,
  });
  await conn.connect();
  conn.subscribe([{ kinds: [1301, 1302] }], (e) => received.push(e));
});

afterAll(async () => {
  conn.disconnect();
  await relay.stop();
});

describe("RelayConnection survives drops", () => {
  test(
    "live events resume after the socket is severed",
    async () => {
      const e1 = await sideChannelPublish({ kind: 1301, content: "before drop" });
      await waitFor(() => received.some((e) => e.id === e1.id), 5000, "pre-drop event");

      relay.dropClients();
      // The world keeps moving while we're down.
      const e2 = await sideChannelPublish({ kind: 1301, content: "during outage" });

      // The watchdog (200ms here) must detect the drop, reconnect, and
      // resubscribe with the skew-rewound watermark — no caller involvement.
      await waitFor(() => received.some((e) => e.id === e2.id), 15000, "missed event after reconnect");
      expect(received.filter((e) => e.id === e2.id)).toHaveLength(1); // deduped, delivered once
    },
    30000
  );

  test(
    "skew backfill recovers a backdated straggler the +1 watermark would miss",
    async () => {
      // Watermark is now ~current time. A straggler stamped 60s in the past
      // is invisible to since=watermark+1 — only the skew backfill finds it.
      relay.dropClients();
      const straggler = await sideChannelPublish({
        kind: 1302,
        content: "backdated straggler",
        created_at: Math.floor(Date.now() / 1000) - 60,
      });

      // Original-filter resubscribe recovers this (the filter has no since);
      // a bare since=watermark+1 resubscribe never would. Same property
      // protects fuzzed-created_at kinds like NIP-17 gift wraps.
      await waitFor(() => received.some((e) => e.id === straggler.id), 20000, "skew-backfilled straggler");
      expect(received.filter((e) => e.id === straggler.id)).toHaveLength(1);
    },
    30000
  );

  test(
    "publish retries across a drop instead of losing the event",
    async () => {
      relay.dropClients();
      const event = finalizeEvent(
        { kind: 1301, created_at: Math.floor(Date.now() / 1000), tags: [], content: "published through a drop" },
        sk
      );
      await conn.publish(event); // must not throw; retry ladder covers the reconnect
      expect(relay.events.some((e) => e.id === event.id)).toBe(true);
    },
    30000
  );

  test(
    "policy rejection (OK=false) fails fast — no retry ladder",
    async () => {
      relay.blockedKinds.add(1303);
      const event = finalizeEvent(
        { kind: 1303, created_at: Math.floor(Date.now() / 1000), tags: [], content: "rejected" },
        sk
      );
      const t0 = Date.now();
      await expect(conn.publish(event)).rejects.toThrow(/blocked/);
      expect(Date.now() - t0).toBeLessThan(2000); // immediate, not 13s of retries
      relay.blockedKinds.delete(1303);
    },
    30000
  );

  test("watchdog surfaced the disconnect/reconnect transitions", () => {
    expect(disconnects).toBeGreaterThanOrEqual(1);
    expect(connects).toBeGreaterThanOrEqual(2); // initial + at least one reconnect
  });
});
