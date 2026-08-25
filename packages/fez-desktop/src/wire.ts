import { invoke } from "@tauri-apps/api/core";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { nip44, nip59, type Event, type EventTemplate } from "nostr-tools";
import type { Wire, WireEvent, WireFilter, DmRumor, RelayInfoDoc } from "@fezchat/client";
import { fetchRelayInfo } from "../../../src/protocol/nip11.js";

/**
 * Browser Wire for @fezchat/client — the same eight-function seam the TUI
 * assembles in node, built on plain WebSockets (webviews can't use
 * nostr-tools' node-flavored pool helpers, and a direct implementation
 * is ~150 lines anyway). Auto-reconnects with full-filter resubscribe +
 * seen-set dedup — the same recovery decision as src/relay.ts, for the
 * same reason (fuzzed-created_at kinds forbid watermark rewinds).
 *
 * One socket PER RELAY, and the same three rules src/relay.ts spells
 * out: publishes fan out and succeed on the first acceptance, reads are
 * the union deduped by id, and every relay is reconnected rather than
 * only the last one standing. The GUI having its own wire is exactly how
 * a desktop app ends up quietly single-relay while the CLI isn't.
 *
 * Custody: crypto goes through a SIGNER seam. The app passes rustSigner
 * — the key stays in Rust (macOS keychain → in-process cache), the
 * webview asks for signatures and DM crypto over the invoke bridge, and
 * a fully compromised webview could misuse those operations while the
 * app is open but cannot exfiltrate the identity (Buzz's model). Tests
 * and node hosts pass a 64-hex secret instead, which builds the
 * in-process localSigner — same seam, keys where the host wants them.
 */

const KIND_DM = 14;

/** A rumor as the signer hands it back — pre-signature event shape. */
interface Rumor {
  kind: number;
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

export interface WireSigner {
  pubkey: string;
  sign(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> | WireEvent;
  encrypt(peerPubkey: string, plaintext: string): Promise<string> | string;
  decrypt(peerPubkey: string, ciphertext: string): Promise<string> | string;
  /** ONE rumor wrapped for every recipient — a shared rumor id is what
   * makes a group DM one message instead of N. */
  wrapDm(kind: number, content: string, tags: string[][], recipients: string[]): Promise<{ rumorId: string; wraps: WireEvent[] }>;
  unwrap(event: WireEvent): Promise<Rumor | undefined> | (Rumor | undefined);
}

/** The app's signer: Rust holds the key; this side never sees it. */
export function rustSigner(pubkey: string): WireSigner {
  return {
    pubkey,
    async sign(tmpl) {
      return JSON.parse(
        await invoke<string>("sign_event", { kind: tmpl.kind, content: tmpl.content, tags: tmpl.tags, createdAt: tmpl.created_at })
      ) as WireEvent;
    },
    encrypt: (peer, plaintext) => invoke<string>("nip44_encrypt", { peer, plaintext }),
    decrypt: (peer, ciphertext) => invoke<string>("nip44_decrypt", { peer, ciphertext }),
    async wrapDm(kind, content, tags, recipients) {
      return JSON.parse(await invoke<string>("dm_wrap_all", { kind, content, tags, recipients })) as {
        rumorId: string;
        wraps: WireEvent[];
      };
    },
    async unwrap(event) {
      try {
        return JSON.parse(await invoke<string>("dm_unwrap", { event: JSON.stringify(event) })) as Rumor;
      } catch {
        return undefined; // not for us — same silence as the local path
      }
    },
  };
}

/** In-process signer for hosts that hold the key themselves (tests, node). */
export function localSigner(keyHex: string): WireSigner {
  const secret = Uint8Array.from(keyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const pubkey = getPublicKey(secret);
  return {
    pubkey,
    sign: (tmpl) =>
      finalizeEvent(
        { kind: tmpl.kind, created_at: tmpl.created_at ?? Math.floor(Date.now() / 1000), tags: tmpl.tags, content: tmpl.content },
        secret
      ) as WireEvent,
    encrypt: (peer, plaintext) => nip44.encrypt(plaintext, nip44.getConversationKey(secret, peer)),
    decrypt: (peer, ciphertext) => nip44.decrypt(ciphertext, nip44.getConversationKey(secret, peer)),
    async wrapDm(kind, content, tags, recipients) {
      const rumor = nip59.createRumor({ kind, tags, content } as EventTemplate, secret);
      const wraps = recipients.map((pk) => nip59.createWrap(nip59.createSeal(rumor, secret, pk), pk) as unknown as WireEvent);
      return { rumorId: (rumor as { id: string }).id, wraps };
    },
    unwrap(event) {
      try {
        return nip59.unwrapEvent(event as unknown as Event, secret) as unknown as Rumor;
      } catch {
        return undefined;
      }
    },
  };
}

interface Sub {
  id: string;
  filters: WireFilter[];
  onEvent: (event: WireEvent) => void;
  /** Shared across relays: the same event from four relays arrives once. */
  seen: Set<string>;
}

interface QueryBucket {
  events: WireEvent[];
  resolve: (events: WireEvent[]) => void;
  /** Relays we're still waiting on — resolving on the FIRST EOSE would
   * discard whatever the slower relays were about to send. */
  awaiting: Set<string>;
  done: boolean;
}

interface PendingOk {
  resolve: () => void;
  reject: (err: Error) => void;
  awaiting: Set<string>;
  accepted: boolean;
  settled: boolean;
  reasons: string[];
}

export class BrowserWire implements Wire {
  readonly pubkey: string;
  private signer: WireSigner;
  private urls: string[];

  private sockets = new Map<string, WebSocket>();
  private subs = new Map<string, Sub>();
  private pendingOks = new Map<string, PendingOk>();
  private queryBuckets = new Map<string, QueryBucket>();
  private serial = 0;
  private closed = false;
  onStatus?: (connected: boolean) => void;
  onError?: (message: string) => void;
  /** Per-relay picture, so the UI can say "2 of 3" instead of a green dot. */
  onRelayHealth?: (health: { url: string; connected: boolean }[]) => void;

  private watchdog?: ReturnType<typeof setInterval>;
  /** Consecutive failed connects per relay — drives the backoff below. */
  private attempts = new Map<string, number>();
  /** Earliest next reconnect per relay; the watchdog respects it too. */
  private nextTry = new Map<string, number>();

  constructor(urls: string | string[], keyOrSigner: string | WireSigner) {
    this.urls = [...new Set((Array.isArray(urls) ? urls : [urls]).map((u) => u.trim()).filter(Boolean))];
    if (this.urls.length === 0) throw new Error("BrowserWire: no relay URLs given");
    this.signer = typeof keyOrSigner === "string" ? localSigner(keyOrSigner) : keyOrSigner;
    this.pubkey = this.signer.pubkey;
    for (const url of this.urls) this.connect(url);
    // Belt-and-braces recovery: whatever state an old socket wedges in
    // (HMR remounts, sleep/wake, orphaned handlers), a socket that isn't
    // OPEN or CONNECTING gets replaced. The onclose reconnect is the
    // fast path; this is the guarantee. EVERY relay is checked — the
    // shortcut of stopping once one is healthy is how a set decays into
    // a single relay without anything appearing to be wrong.
    this.watchdog = setInterval(() => {
      if (this.closed) return;
      for (const url of this.urls) {
        const state = this.sockets.get(url)?.readyState;
        // Respect the backoff window — without this check the watchdog
        // defeated it, hammering an unreachable relay every 5s forever
        // (a fully-offline machine ran a permanent reconnect storm).
        if (Date.now() < (this.nextTry.get(url) ?? 0)) continue;
        if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) this.connect(url);
      }
    }, 5000);
  }

  private openCount(): number {
    return this.urls.filter((url) => this.sockets.get(url)?.readyState === WebSocket.OPEN).length;
  }

  health(): { url: string; connected: boolean }[] {
    return this.urls.map((url) => ({ url, connected: this.sockets.get(url)?.readyState === WebSocket.OPEN }));
  }

  relayUrls(): readonly string[] {
    return this.urls;
  }

  private reportStatus(): void {
    this.onStatus?.(this.openCount() > 0);
    this.onRelayHealth?.(this.health());
  }

  private connect(url: string): void {
    if (this.closed) return;
    const ws = new WebSocket(url);
    this.sockets.set(url, ws);
    ws.onopen = () => {
      this.attempts.delete(url);
      this.nextTry.delete(url);
      this.reportStatus();
      // A relay that just arrived has no subscriptions of its own.
      for (const sub of this.subs.values()) this.fireTo(url, sub);
    };
    ws.onclose = () => {
      this.reportStatus();
      // Anything waiting on this relay must stop waiting, or a query
      // hangs for its full timeout every time one relay is down.
      for (const bucket of this.queryBuckets.values()) this.dropFromBucket(bucket, url);
      for (const [id, pending] of this.pendingOks) this.dropFromOk(id, pending, url, "relay disconnected");
      if (!this.closed) {
        // 2s → 4s → 8s … capped at 30s, reset by a successful open — a
        // down relay gets patience, not a fixed-rate hammer.
        const failures = (this.attempts.get(url) ?? 0) + 1;
        this.attempts.set(url, failures);
        const delay = Math.min(30_000, 2000 * 2 ** (failures - 1));
        this.nextTry.set(url, Date.now() + delay);
        setTimeout(() => this.connect(url), delay);
      }
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
        // Dedupe inside the bucket too: the same event from three relays
        // is one row, not three.
        if (bucket && !bucket.events.some((e) => e.id === event.id)) bucket.events.push(event);
      } else if (type === "EOSE") {
        const bucket = this.queryBuckets.get(a);
        if (bucket) {
          this.sendTo(url, ["CLOSE", a]);
          this.dropFromBucket(bucket, url, a);
        }
      } else if (type === "OK") {
        const pending = this.pendingOks.get(a);
        if (pending) {
          const [, , accepted, reason] = msg as [string, string, boolean, string];
          if (accepted) {
            pending.accepted = true;
            pending.awaiting.delete(url);
            if (!pending.settled) {
              // First acceptance wins: the event is published. Slower
              // relays keep receiving it, they just aren't waited on.
              pending.settled = true;
              this.pendingOks.delete(a);
              pending.resolve();
            }
          } else {
            this.dropFromOk(a, pending, url, reason || "rejected");
          }
        }
      } else if (type === "AUTH") {
        // NIP-42 challenge: sign and answer with the user's key. The
        // relay tag names THIS relay — a challenge answered with another
        // relay's url is a valid signature over the wrong statement.
        void this.sign({ kind: 22242, tags: [["relay", url], ["challenge", a]], content: "" })
          .then((auth) => this.sendTo(url, ["AUTH", auth]))
          .catch(() => {});
      }
    };
  }

  private dropFromBucket(bucket: QueryBucket, url: string, id?: string): void {
    bucket.awaiting.delete(url);
    if (bucket.done || bucket.awaiting.size > 0) return;
    bucket.done = true;
    if (id) this.queryBuckets.delete(id);
    else {
      for (const [key, value] of this.queryBuckets) if (value === bucket) this.queryBuckets.delete(key);
    }
    bucket.resolve(bucket.events);
  }

  private dropFromOk(id: string, pending: PendingOk, url: string, reason: string): void {
    if (pending.settled) return;
    pending.awaiting.delete(url);
    pending.reasons.push(`${url}: ${reason}`);
    if (pending.awaiting.size > 0) return;
    pending.settled = true;
    this.pendingOks.delete(id);
    // Only a rejection by EVERY relay is a failed publish.
    if (pending.accepted) pending.resolve();
    else pending.reject(new Error(pending.reasons.join("; ")));
  }

  /**
   * Wait for at least one relay, briefly.
   *
   * A client's first queries run the instant it is constructed — the
   * socket is still CONNECTING, which is a millisecond away from ready
   * and indistinguishable from "offline" if you only look at
   * readyState. Answering those with an empty result is answering a
   * question about the relay without asking it, and the caller has no
   * way to tell the difference between "nothing there" and "asked too
   * early". That mistake is what emptied a real user's client of every
   * community it belonged to.
   */
  private whenConnected(timeoutMs = 5000): Promise<boolean> {
    if (this.openCount() > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.closed || this.openCount() > 0) {
          clearInterval(timer);
          resolve(this.openCount() > 0);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 40);
    });
  }

  private send(frame: unknown[]): void {
    for (const url of this.urls) this.sendTo(url, frame);
  }

  private sendTo(url: string, frame: unknown[]): void {
    const ws = this.sockets.get(url);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private fire(sub: Sub): void {
    for (const url of this.urls) this.fireTo(url, sub);
  }

  private fireTo(url: string, sub: Sub): void {
    // One REQ per filter (matches fez-relay's per-filter matching); a
    // shared sub id merges their streams client-side via the seen-set.
    for (const [index, filter] of sub.filters.entries()) {
      this.sendTo(url, ["REQ", `${sub.id}:${index}`, filter]);
    }
  }

  subscribe(filters: WireFilter[], onEvent: (event: WireEvent) => void): () => void {
    const id = `s${this.serial++}`;
    const sub: Sub = { id, filters: filters.map((f) => ({ ...f })), onEvent, seen: new Set() };
    // Register under each per-filter REQ id so EVENT routing finds it.
    for (const [index] of filters.entries()) this.subs.set(`${id}:${index}`, sub);
    // Fires now if connected; ws.onopen re-fires it for every relay
    // that arrives later, so an early subscribe is never lost.
    if (this.openCount() > 0) this.fire(sub);
    return () => {
      for (const [index] of filters.entries()) {
        this.subs.delete(`${id}:${index}`);
        this.send(["CLOSE", `${id}:${index}`]);
      }
    };
  }

  async query(filters: WireFilter[]): Promise<WireEvent[]> {
    // Give a connecting socket a moment — see whenConnected().
    await this.whenConnected();
    const results = await Promise.all(
      filters.map(
        (filter) =>
          new Promise<WireEvent[]>((resolve) => {
            const id = `q${this.serial++}`;
            const live = this.urls.filter((url) => this.sockets.get(url)?.readyState === WebSocket.OPEN);
            // Still nothing after waiting: answer empty rather than
            // stalling the UI for eight seconds on every panel.
            if (live.length === 0) return resolve([]);
            const bucket: QueryBucket = { events: [], resolve, awaiting: new Set(live), done: false };
            this.queryBuckets.set(id, bucket);
            for (const url of live) this.sendTo(url, ["REQ", id, filter]);
            setTimeout(() => {
              // Backstop for a relay that accepts the REQ and never
              // EOSEs. Whatever the others returned is still an answer.
              if (!bucket.done) {
                bucket.done = true;
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

  /** The custody seam — whoever the signer is, the wire never holds a key. */
  private async sign(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    return this.signer.sign(tmpl);
  }

  async publish(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    const event = await this.sign(tmpl);
    await this.publishSigned(event);
    return event;
  }

  /**
   * Fan out to every connected relay; resolve on the first acceptance.
   * A relay that rejects while another accepts does not fail the
   * publish — the event exists, and telling the user otherwise would be
   * false. Only a rejection by all of them is a failure.
   */
  private async publishSigned(event: WireEvent): Promise<void> {
    // Same reason as query: a publish fired during boot is milliseconds
    // ahead of the socket, not offline.
    await this.whenConnected();
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        this.onError?.(message);
        reject(new Error(message));
      };
      const live = this.urls.filter((url) => this.sockets.get(url)?.readyState === WebSocket.OPEN);
      if (live.length === 0) {
        fail(
          this.urls.length === 1
            ? "not connected to the relay — reconnecting, try again in a moment"
            : `not connected to any of your ${this.urls.length} relays — reconnecting, try again in a moment`
        );
        return;
      }
      const pending: PendingOk = {
        resolve,
        reject: (err) => fail(err.message),
        awaiting: new Set(live),
        accepted: false,
        settled: false,
        reasons: [],
      };
      this.pendingOks.set(event.id, pending);
      for (const url of live) this.sendTo(url, ["EVENT", event]);
      setTimeout(() => {
        if (pending.settled) return;
        pending.settled = true;
        this.pendingOks.delete(event.id);
        if (pending.accepted) resolve();
        else fail("publish timed out — no relay acknowledged");
      }, 10_000);
    });
  }

  /** Sign WITHOUT publishing — for events that travel outside the relay (Blossom auth headers). */
  /**
   * NIP-98, browser-shaped: same event the CLI credential helper signs
   * (src/nip98.ts builds it node-side), base64 via TextEncoder because
   * a webview has no Buffer. Signed over the URL the caller will be
   * verified against — for repo-scoped endpoints that is the PATH-ONLY
   * url (the server's verifier strips queries; see gitRepoPath).
   */
  async httpAuth(url: string, method: string): Promise<string> {
    const event = await this.sign({ kind: 27235, tags: [["u", url], ["method", method.toUpperCase()]], content: "" });
    const bytes = new TextEncoder().encode(JSON.stringify(event));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return `Nostr ${btoa(binary)}`;
  }

  async signEvent(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    return this.sign(tmpl);
  }

  encrypt(peerPubkey: string, plaintext: string): string | Promise<string> {
    return this.signer.encrypt(peerPubkey, plaintext);
  }

  decrypt(peerPubkey: string, ciphertext: string): string | Promise<string> {
    return this.signer.decrypt(peerPubkey, ciphertext);
  }

  // NIP-17 — same wrap shape as src/dm.ts (kind-14 rumor, seal, gift
  // wrap to peer + self-copy; depth rides inside the rumor). ONE Rust
  // call wraps for every recipient so the rumor id is shared.
  async sendDm(recipientPubkey: string, text: string): Promise<string> {
    return this.sendGroupDm([recipientPubkey], text);
  }

  async sendGroupDm(recipientPubkeys: string[], text: string): Promise<string> {
    const others = [...new Set(recipientPubkeys)].filter((pk) => pk !== this.pubkey);
    const { rumorId, wraps } = await this.signer.wrapDm(
      KIND_DM,
      text,
      others.map((pk) => ["p", pk]),
      [...others, this.pubkey]
    );
    for (const wrap of wraps) await this.publishSigned(wrap);
    return rumorId;
  }

  /**
   * The workspace's identity card. Asked of the FIRST relay: under the
   * flat model a workspace is one relay, and any extra URLs are mirrors
   * of it, so the primary is the one that names the owner.
   */
  get relays(): string[] {
    return this.urls;
  }

  async relayInfo(relay?: string): Promise<RelayInfoDoc | undefined> {
    return fetchRelayInfo(relay || this.urls[0]);
  }

  async unwrapDm(event: WireEvent): Promise<DmRumor | undefined> {
    if (event.kind !== 1059) return undefined;
    try {
      const rumor = await this.signer.unwrap(event);
      if (!rumor || rumor.kind !== KIND_DM || typeof rumor.content !== "string") return undefined;
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
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
  }
}
