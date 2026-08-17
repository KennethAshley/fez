import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { nip44, nip59, type Event, type EventTemplate } from "nostr-tools";
import type { Wire, WireEvent, WireFilter, DmRumor } from "@fez/client";

/**
 * Browser Wire for @fez/client — the same eight-function seam the TUI
 * assembles in node, built on a plain WebSocket (webviews can't use
 * nostr-tools' node-flavored pool helpers, and a direct implementation
 * is ~150 lines anyway). Auto-reconnects with full-filter resubscribe +
 * seen-set dedup — the same recovery decision as src/relay.ts, for the
 * same reason (fuzzed-created_at kinds forbid watermark rewinds).
 *
 * Custody: the key hex arrives from the Tauri shell (macOS keychain) and
 * lives in webview memory for the session — identical trust model to the
 * TUI process holding it.
 */

const KIND_DM = 14;

interface Sub {
  id: string;
  filters: WireFilter[];
  onEvent: (event: WireEvent) => void;
  seen: Set<string>;
}

export class BrowserWire implements Wire {
  readonly pubkey: string;
  private secret: Uint8Array;
  private url: string;
  private ws?: WebSocket;
  private subs = new Map<string, Sub>();
  private pendingOks = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private queryBuckets = new Map<string, { events: WireEvent[]; resolve: (e: WireEvent[]) => void }>();
  private serial = 0;
  private closed = false;
  onStatus?: (connected: boolean) => void;
  onError?: (message: string) => void;

  private watchdog?: ReturnType<typeof setInterval>;

  constructor(url: string, keyHex: string) {
    this.url = url;
    this.secret = Uint8Array.from(keyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    this.pubkey = getPublicKey(this.secret);
    this.connect();
    // Belt-and-braces recovery: whatever state an old socket wedges in
    // (HMR remounts, sleep/wake, orphaned handlers), a socket that isn't
    // OPEN or CONNECTING gets replaced. The onclose reconnect is the
    // fast path; this is the guarantee.
    this.watchdog = setInterval(() => {
      if (this.closed) return;
      const state = this.ws?.readyState;
      if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) this.connect();
    }, 5000);
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus?.(true);
      for (const sub of this.subs.values()) this.fire(sub);
    };
    ws.onclose = () => {
      this.onStatus?.(false);
      if (!this.closed) setTimeout(() => this.connect(), 2000);
    };
    ws.onmessage = (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(raw.data as string);
      } catch {
        return;
      }
      const [type, a, b] = msg as [string, string, never];
      if (type === "EVENT") {
        const sub = this.subs.get(a);
        const event = b as WireEvent;
        if (sub && !sub.seen.has(event.id)) {
          sub.seen.add(event.id);
          sub.onEvent(event);
        }
        const bucket = this.queryBuckets.get(a);
        if (bucket) bucket.events.push(event);
      } else if (type === "EOSE") {
        const bucket = this.queryBuckets.get(a);
        if (bucket) {
          this.queryBuckets.delete(a);
          this.send(["CLOSE", a]);
          bucket.resolve(bucket.events);
        }
      } else if (type === "OK") {
        const pending = this.pendingOks.get(a);
        if (pending) {
          this.pendingOks.delete(a);
          if ((msg as [string, string, boolean, string])[2]) pending.resolve();
          else pending.reject(new Error((msg as [string, string, boolean, string])[3] ?? "rejected"));
        }
      } else if (type === "AUTH") {
        // NIP-42 challenge: sign and answer with the user's key.
        const auth = finalizeEvent(
          {
            kind: 22242,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["relay", this.url], ["challenge", a]],
            content: "",
          },
          this.secret
        );
        this.send(["AUTH", auth]);
      }
    };
  }

  private send(frame: unknown[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private fire(sub: Sub): void {
    // One REQ per filter (matches fez-relay's per-filter matching); a
    // shared sub id merges their streams client-side via the seen-set.
    for (const [index, filter] of sub.filters.entries()) {
      this.send(["REQ", `${sub.id}:${index}`, filter]);
    }
  }

  subscribe(filters: WireFilter[], onEvent: (event: WireEvent) => void): () => void {
    const id = `s${this.serial++}`;
    const sub: Sub = { id, filters: filters.map((f) => ({ ...f })), onEvent, seen: new Set() };
    // Register under each per-filter REQ id so EVENT routing finds it.
    for (const [index] of filters.entries()) this.subs.set(`${id}:${index}`, sub);
    if (this.ws?.readyState === WebSocket.OPEN) this.fire(sub);
    return () => {
      for (const [index] of filters.entries()) {
        this.subs.delete(`${id}:${index}`);
        this.send(["CLOSE", `${id}:${index}`]);
      }
    };
  }

  async query(filters: WireFilter[]): Promise<WireEvent[]> {
    const results = await Promise.all(
      filters.map(
        (filter) =>
          new Promise<WireEvent[]>((resolve) => {
            const id = `q${this.serial++}`;
            this.queryBuckets.set(id, { events: [], resolve });
            this.send(["REQ", id, filter]);
            setTimeout(() => {
              const bucket = this.queryBuckets.get(id);
              if (bucket) {
                this.queryBuckets.delete(id);
                resolve(bucket.events);
              }
            }, 8000);
          })
      )
    );
    const byId = new Map<string, WireEvent>();
    for (const events of results) for (const event of events) byId.set(event.id, event);
    return [...byId.values()];
  }

  async publish(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    const event = finalizeEvent(
      {
        kind: tmpl.kind,
        created_at: tmpl.created_at ?? Math.floor(Date.now() / 1000),
        tags: tmpl.tags,
        content: tmpl.content,
      },
      this.secret
    ) as WireEvent;
    await this.publishSigned(event as unknown as Event);
    return event;
  }

  private publishSigned(event: Event): Promise<void> {
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        this.onError?.(message);
        reject(new Error(message));
      };
      if (this.ws?.readyState !== WebSocket.OPEN) {
        fail("not connected to the relay — reconnecting, try again in a moment");
        return;
      }
      this.pendingOks.set(event.id, { resolve, reject: (e) => fail(e.message) });
      this.send(["EVENT", event]);
      setTimeout(() => {
        if (this.pendingOks.delete(event.id)) fail("publish timed out — relay didn't acknowledge");
      }, 10_000);
    });
  }

  /** Sign WITHOUT publishing — for events that travel outside the relay (Blossom auth headers). */
  signEvent(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Event {
    return finalizeEvent(
      {
        kind: tmpl.kind,
        created_at: tmpl.created_at ?? Math.floor(Date.now() / 1000),
        tags: tmpl.tags,
        content: tmpl.content,
      },
      this.secret
    );
  }

  encrypt(peerPubkey: string, plaintext: string): string {
    return nip44.encrypt(plaintext, nip44.getConversationKey(this.secret, peerPubkey));
  }

  decrypt(peerPubkey: string, ciphertext: string): string {
    return nip44.decrypt(ciphertext, nip44.getConversationKey(this.secret, peerPubkey));
  }

  // NIP-17 — same wrap shape as src/dm.ts (kind-14 rumor, seal, gift
  // wrap to peer + self-copy; depth rides inside the rumor).
  async sendDm(recipientPubkey: string, text: string): Promise<string> {
    return this.sendGroupDm([recipientPubkey], text);
  }

  async sendGroupDm(recipientPubkeys: string[], text: string): Promise<string> {
    const others = [...new Set(recipientPubkeys)].filter((pk) => pk !== this.pubkey);
    const rumor = nip59.createRumor(
      { kind: KIND_DM, tags: others.map((pk) => ["p", pk]), content: text } as EventTemplate,
      this.secret
    );
    for (const pk of [...others, this.pubkey]) {
      const wrap = nip59.createWrap(nip59.createSeal(rumor, this.secret, pk), pk);
      await this.publishSigned(wrap as Event);
    }
    return (rumor as { id: string }).id;
  }

  unwrapDm(event: WireEvent): DmRumor | undefined {
    if (event.kind !== 1059) return undefined;
    try {
      const rumor = nip59.unwrapEvent(event as unknown as Event, this.secret) as {
        kind: number;
        id: string;
        pubkey: string;
        content: string;
        created_at: number;
        tags: string[][];
      };
      if (rumor.kind !== KIND_DM || typeof rumor.content !== "string") return undefined;
      const recipients = rumor.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]);
      const peerPk = rumor.pubkey === this.pubkey ? recipients[0] : rumor.pubkey;
      if (!peerPk) return undefined;
      return {
        senderPk: rumor.pubkey,
        peerPk,
        text: rumor.content,
        ts: rumor.created_at,
        depth: Number(rumor.tags.find((t) => t[0] === "depth")?.[1] ?? 0),
        id: rumor.id,
        participants: [...new Set([rumor.pubkey, ...recipients])].sort(),
      };
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.watchdog);
    this.ws?.close();
  }
}
