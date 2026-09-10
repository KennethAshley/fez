import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket as WsSocket } from "ws";
import { verifyEvent } from "nostr-tools/pure";
import { matchFilter, type Event, type Filter } from "nostr-tools";

/**
 * A killable in-process NIP-01 subset (dev/local-relay.ts distilled).
 *
 * Events persist across socket drops, so "the world kept moving while we
 * were gone" is simulated by terminating only the client's sockets;
 * stop()/start() simulates the relay itself going away and coming back.
 */
export class MiniRelay {
  events: Event[] = [];
  private wss?: WebSocketServer;
  private subs = new Map<string, { subId: string; filters: Filter[]; ws: WsSocket }>();
  private connCounter = 0;
  /** kinds the relay rejects with OK=false, to test the no-retry path */
  blockedKinds = new Set<number>();
  /**
   * The workspace's identity card. A relay IS a workspace, so a client
   * reads who owns it from here before trusting any channel or roster —
   * served over HTTP on the same port, exactly like the real relay.
   */
  workspace: { name?: string; owner?: string } = {};
  private http?: Server;

  constructor(public port = 0) {}

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http = createServer((req, res) => {
        const body = JSON.stringify({ name: this.workspace.name, pubkey: this.workspace.owner });
        res.writeHead(200, { "content-type": "application/nostr+json", "access-control-allow-origin": "*" });
        res.end(req.method === "HEAD" ? undefined : body);
      });
      this.wss = new WebSocketServer({ server: this.http });
      this.http.once("error", reject);
      this.wss.once("error", reject);
      this.http.listen(this.port, "127.0.0.1", () => {
        const address = this.http!.address();
        if (address && typeof address !== "string") this.port = address.port;
        resolve();
      });
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
            if (!this.events.some((e) => e.id === event.id)) this.events.push(event);
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
            const history = new Map(filters.flatMap(filter => this.events.filter(event => matchFilter(filter, event))
              .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
              .slice(0, filter.limit)).map(event => [event.id, event]));
            for (const e of history.values()) {
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

  /** Take the relay down. Its events survive in memory for a later start(). */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.dropClients();
      if (!this.wss) return resolve();
      const server = this.wss;
      const http = this.http;
      this.wss = undefined;
      this.http = undefined;
      server.close(() => (http ? http.close(() => resolve()) : resolve()));
    });
  }

  has(id: string): boolean {
    return this.events.some((e) => e.id === id);
  }
}

export function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
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
    }, 25);
  });
}

/**
 * Wait until a spawned relay is actually accepting connections.
 *
 * These suites used to sleep a fixed 900ms after spawn and hope. That
 * holds on a warm laptop and fails on a cold CI runner, where the same
 * two suites burned 65s and 126s failing every assertion after the
 * first — not a logic error, a race the sleep only papered over.
 *
 * Polls the port instead, so it costs a few milliseconds when the relay
 * is quick and still waits when the machine is loaded.
 */
export async function waitForPort(
  port: number,
  timeoutMs = 20_000,
  /**
   * The spawned process, so a boot failure reports ITS error, not ours.
   *
   * `stderr` is nullable, not merely absent: node types ChildProcess.stderr
   * as `Readable | null` (it is null whenever that fd was not piped), so a
   * caller passing a real ChildProcess would not type-check against an
   * optional-only shape. The body already optional-chains through it.
   */
  child?: { stderr?: { on(e: "data", f: (c: unknown) => void): void } | null }
): Promise<void> {
  let stderr = "";
  child?.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const { connect } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
    if (open) return;
    if (Date.now() > deadline) {
      throw new Error(
        `relay never listened on ${port} within ${timeoutMs}ms` +
          (stderr.trim() ? `\nits stderr:\n${stderr.trim().slice(0, 2000)}` : " (and wrote nothing to stderr)")
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
