import { type Filter, type Event } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";

export interface RelayOptions {
  url: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: Error) => void;
  /** Connectivity-watchdog poll interval (ms). Mainly for tests. */
  watchdogMs?: number;
  /**
   * NIP-42: when the relay sends an AUTH challenge, sign the kind-22242
   * auth event with this and reply automatically. Optional — a relay that
   * never challenges (fez-relay without read-side policies) costs
   * nothing; a challenge with no signer is simply ignored (the relay may
   * then withhold read-gated events).
   */
  authSigner?: (template: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<Event>;
}

// The watchdog is the reconnect ladder: every tick it checks liveness and,
// if we're down with live subscriptions, re-establishes + resubscribes.
// 3s ≈ Buzz's early-ladder cadence without a burst of instant retries.
const WATCHDOG_MS = 3_000;

// On resubscribe after a drop, each subscription re-issues its ORIGINAL
// filters and lets the per-subscription seen-set drop replayed duplicates.
// A since-watermark rewind (Buzz-style) would be cheaper on the wire, but
// NIP-01 filters select on created_at, not arrival time — and fez carries
// kinds whose created_at is deliberately fuzzed days into the past (NIP-17
// gift wraps). Any watermark cutoff silently loses those after an outage.
// Full re-issue is the only recovery that's correct for every kind.

// Publish retries cover the reconnect window after a drop. Only transient
// failures retry — an OK=false policy rejection is final and rethrows
// immediately. Re-sending the same event id is idempotent relay-side.
const PUBLISH_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

const CONNECT_TIMEOUT_MS = 5_000;
const SEEN_CAP = 10_000;

interface TrackedSub {
  /** Caller's original filters, never mutated (the library mutates its copies). */
  filters: Filter[];
  onEvent: (event: Event) => void;
  onEose?: () => void;
  eoseFired: boolean;
  seen: Set<string>;
  close: () => void;
}

function isTransientPublishError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timed? ?out|closed|connection|failed|websocket|ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN/i.test(
    msg
  );
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Lightweight relay connection wrapper.
 *
 * Built on nostr-tools SimplePool with enablePing (dead-socket detection:
 * ws.ping() where supported, dummy-REQ probe on Node's native WebSocket).
 * Reconnection is owned here, not by the library — nostr-tools'
 * enableReconnect gives up permanently when an *established* socket dies
 * with an error frame (its onerror path treats attempt-zero errors as
 * "relay unreachable"), which is exactly the network-blip case a standing
 * agent must survive. The wrapper instead:
 *
 *  - tracks every subscription (original filters + seen-set),
 *  - polls liveness on a watchdog; on a drop it reconnects and re-issues
 *    each subscription's original filters, deduped by the seen-set (see
 *    the fuzzed-created_at note above for why not a since-watermark),
 *  - retries publishes across the reconnect window (transient errors only;
 *    relay policy rejections fail fast),
 *  - surfaces onConnect/onDisconnect so standing agents can log transitions.
 */
export class RelayConnection {
  private pool: SimplePool;
  private url: string;
  private tracked: Map<string, TrackedSub> = new Map();
  private watchdog?: ReturnType<typeof setInterval>;
  private wasConnected = false;
  private reconnecting = false;
  private closed = false;

  constructor(private options: RelayOptions) {
    this.url = options.url;
    const { authSigner } = options;
    // nostr-tools auto-answers AUTH challenges when the relay instance
    // has an onauth signer; automaticallyAuth supplies it per-URL. The
    // option is real at runtime (AbstractSimplePool) but SimplePool's
    // constructor Pick<> omits it — hence the cast.
    const poolOptions = {
      enablePing: true,
      automaticallyAuth: authSigner
        ? () => (evt: unknown) => authSigner(evt as never) as Promise<never>
        : undefined,
    };
    this.pool = new SimplePool(poolOptions as ConstructorParameters<typeof SimplePool>[0]);
  }

  private relayConnected(): boolean {
    const pool = this.pool as unknown as { relays: Map<string, { connected: boolean }> };
    for (const relay of pool.relays.values()) {
      if (relay.connected) return true;
    }
    return false;
  }

  /**
   * Connect and, when an authSigner is configured, complete the NIP-42
   * handshake BEFORE returning — otherwise the first REQ races the AUTH
   * reply and a read-gated relay answers it unauthed (CLOSED
   * auth-required). The challenge arrives asynchronously right after the
   * socket opens, so poll briefly for it.
   */
  private async ensureConnectedAndAuthed(): Promise<void> {
    const relay = await this.pool.ensureRelay(this.url, { connectionTimeout: CONNECT_TIMEOUT_MS });
    const signer = this.options.authSigner;
    if (!signer) return;
    const authable = relay as unknown as { auth(s: (evt: never) => Promise<never>): Promise<string> };
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await authable.auth((evt) => signer(evt) as Promise<never>);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/no challenge/.test(msg)) return; // relay doesn't gate reads, or auth rejected — proceed either way
        await sleep(100);
      }
    }
  }

  async connect(): Promise<void> {
    // Eager connect so startup problems surface at startup — but degrade to
    // the old lazy behavior (first subscribe/publish connects) instead of
    // throwing, so a relay that's briefly down doesn't kill boot.
    try {
      await this.ensureConnectedAndAuthed();
      this.wasConnected = true;
      this.options.onConnect?.();
    } catch (err) {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    this.startWatchdog();
  }

  private startWatchdog(): void {
    if (this.watchdog || this.closed) return;
    this.watchdog = setInterval(() => void this.checkLiveness(), this.options.watchdogMs ?? WATCHDOG_MS);
    // Never hold the process open: one-shot CLI commands must be able to exit.
    this.watchdog.unref?.();
  }

  private async checkLiveness(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    if (this.relayConnected()) {
      if (!this.wasConnected) {
        this.wasConnected = true;
        this.options.onConnect?.();
      }
      return;
    }
    if (this.wasConnected) {
      this.wasConnected = false;
      this.options.onDisconnect?.();
    }
    if (this.tracked.size === 0) return; // nothing to restore; publish/query reconnect on demand
    this.reconnecting = true;
    try {
      await this.ensureConnectedAndAuthed(); // re-auth before resubscribing on gated relays
      for (const sub of this.tracked.values()) this.issue(sub);
      this.wasConnected = true;
      this.options.onConnect?.();
    } catch {
      // still down — next watchdog tick retries
    } finally {
      this.reconnecting = false;
    }
  }

  /** Open (or re-open) the wire subscription for a tracked sub. */
  private issue(sub: TrackedSub): void {
    sub.close(); // no-op on a dead connection; prevents doubled REQs on a live one
    // Fresh copies every time: the library mutates its filter objects.
    const filters = sub.filters.map((f) => ({ ...f }));

    let eoseCount = 0;
    const { authSigner } = this.options;
    // See subscribe() docstring: one subscribeMany() per filter, merged.
    const closers = filters.map((filter) =>
      this.pool.subscribeMany([this.url], filter, {
        onevent: (event) => {
          if (sub.seen.has(event.id)) return;
          this.remember(sub, event);
          sub.onEvent(event);
        },
        oneose: () => {
          eoseCount++;
          if (!sub.eoseFired && eoseCount === filters.length) {
            sub.eoseFired = true;
            sub.onEose?.();
          }
        },
        // Belt & braces for the auth race: a CLOSED "auth-required:" makes
        // nostr-tools auth with this signer and re-fire the subscription.
        onauth: authSigner ? (evt) => authSigner(evt) as Promise<never> : undefined,
      })
    );
    sub.close = () => closers.forEach((c) => c.close());
  }

  private remember(sub: TrackedSub, event: Event): void {
    sub.seen.add(event.id);
    if (sub.seen.size > SEEN_CAP) {
      // Drop the oldest half. Set iterates in insertion order.
      let i = 0;
      const cut = SEEN_CAP / 2;
      for (const id of sub.seen) {
        sub.seen.delete(id);
        if (++i >= cut) break;
      }
    }
  }

  disconnect(): void {
    this.closed = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    this.tracked.forEach((sub) => sub.close());
    this.tracked.clear();
    this.pool.close([this.url]);
  }

  /**
   * Subscribe to events matching any of the given filters (OR semantics).
   * Returns a function to unsubscribe. Survives relay drops: the watchdog
   * re-issues the subscription's original filters and the seen-set drops
   * replayed duplicates (see class doc).
   *
   * nostr-tools' SimplePool.subscribeMany() takes a single Filter per call
   * (despite the "Many" in the name — that refers to relays, not filters),
   * so a multi-filter subscription fans out to one subscribeMany() call per
   * filter and merges their events/EOSE. Passing the filters array straight
   * through gets silently mis-serialized on the wire (NIP-01 REQ ends up
   * with a nested array instead of spread filter objects).
   */
  subscribe(
    filters: Filter[],
    onEvent: (event: Event) => void,
    onEose?: () => void
  ): () => void {
    const id = Math.random().toString(36).slice(2);
    const sub: TrackedSub = {
      filters: filters.map((f) => ({ ...f })),
      onEvent,
      onEose,
      eoseFired: false,
      seen: new Set(),
      close: () => {},
    };
    this.tracked.set(id, sub);
    this.issue(sub);
    this.startWatchdog();

    return () => {
      sub.close();
      this.tracked.delete(id);
    };
  }

  /**
   * Query events (one-shot). Returns a promise with results.
   * See subscribe() above for why this issues one querySync() per filter.
   */
  async query(filters: Filter[], timeoutMs = 5000): Promise<Event[]> {
    const results = await Promise.all(
      filters.map((filter) => this.pool.querySync([this.url], filter, { maxWait: timeoutMs }))
    );
    const byId = new Map<string, Event>();
    for (const events of results) {
      for (const event of events) byId.set(event.id, event);
    }
    return Array.from(byId.values());
  }

  /**
   * Publish a signed event to the relay, awaiting the relay's OK.
   *
   * pool.publish returns Promise[] (one per relay) — awaiting the bare
   * array resolves immediately without waiting for (or surfacing) the
   * actual sends. Bit us live: a short-lived process exited before its
   * events reached the relay, silently.
   *
   * Transient failures (drop, timeout, refused) retry across the reconnect
   * window; a relay policy rejection (OK=false) rethrows immediately —
   * retrying a rejected event is noise.
   */
  async publish(event: Event): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= PUBLISH_RETRY_DELAYS_MS.length; attempt++) {
      try {
        await Promise.all(this.pool.publish([this.url], event));
        return;
      } catch (err) {
        lastErr = err;
        if (!isTransientPublishError(err)) break;
        if (attempt < PUBLISH_RETRY_DELAYS_MS.length) {
          await sleep(PUBLISH_RETRY_DELAYS_MS[attempt]);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
