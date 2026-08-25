import { type Filter, type Event } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { normalizeURL } from "nostr-tools/utils";

export interface RelayHealth {
  url: string;
  connected: boolean;
}

export interface RelayOptions {
  /** A single relay. Kept for callers that mean exactly one (pairing). */
  url?: string;
  /**
   * The relay set. Publishes fan out to all of them; reads are the union,
   * deduped by event id. One entry behaves exactly as `url` did.
   */
  urls?: string[];
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: Error) => void;
  /**
   * Called whenever the per-relay picture changes. "Connected" is a
   * count, not a boolean, once there is more than one relay — and a
   * client that can't say "3 of 4" can't tell you it's been quietly
   * running on one relay for a week.
   */
  onRelayHealth?: (health: RelayHealth[]) => void;
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
 * Lightweight relay connection wrapper — over a SET of relays.
 *
 * The relay set is what makes the system decentralized in fact rather
 * than in principle: no operator, including whoever runs the default
 * relay, is load-bearing. Events fan out to every relay and reads are
 * the union of all of them, deduped by id, so a channel survives any
 * single relay going away, being censored, or losing its store.
 *
 * Three properties, each of which is a way this can quietly not work:
 *
 *  - **Publish succeeds if ANY relay accepts.** All-must-accept would
 *    make the weakest relay in your list a single point of failure —
 *    the exact thing the set exists to remove. Total failure still
 *    throws, and a relay that rejects on policy while another accepts
 *    is reported, not fatal: the event IS published.
 *  - **Reads are a union.** An event that reached only one relay is
 *    still delivered. This is what makes a partitioned publish heal.
 *  - **Every relay is repaired, not just the last one standing.** The
 *    tempting shortcut is "are we connected to anything? then we're
 *    fine", which degrades to a single relay after the first blip and
 *    keeps reporting healthy. Liveness is tracked per relay, and a
 *    relay that comes back gets the subscriptions re-issued.
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
  /** Normalized the way the pool keys its own map — see connectedUrls(). */
  /** The relay set. Under the flat model these are one workspace: the
   *  first is primary (it names the owner), the rest are mirrors. */
  urls: string[];
  private tracked: Map<string, TrackedSub> = new Map();
  private watchdog?: ReturnType<typeof setInterval>;
  private wasConnected = false;
  private lastHealthy = "";
  private reconnecting = false;
  private closed = false;

  constructor(private options: RelayOptions) {
    this.urls = normalizeUrls([...(options.urls ?? []), ...(options.url ? [options.url] : [])]);
    if (this.urls.length === 0) throw new Error("RelayConnection: no relay URLs given");
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

  /**
   * Which relays are actually up right now.
   *
   * The pool keys its map by nostr-tools' NORMALIZED url (it appends a
   * trailing slash), so comparing against raw configured strings finds
   * nothing and every relay looks permanently dead. Our urls are
   * normalized on the way in for exactly this reason.
   */
  private connectedUrls(): Set<string> {
    const pool = this.pool as unknown as { relays: Map<string, { connected: boolean }> };
    const up = new Set<string>();
    for (const [url, relay] of pool.relays) {
      if (relay.connected && this.urls.includes(url)) up.add(url);
    }
    return up;
  }

  /** Per-relay status, for a status bar that can say "2 of 3". */
  health(): RelayHealth[] {
    const up = this.connectedUrls();
    return this.urls.map((url) => ({ url, connected: up.has(url) }));
  }

  /** The relays this connection is configured for. */
  relayUrls(): readonly string[] {
    return this.urls;
  }

  /**
   * Connect and, when an authSigner is configured, complete the NIP-42
   * handshake BEFORE returning — otherwise the first REQ races the AUTH
   * reply and a read-gated relay answers it unauthed (CLOSED
   * auth-required). The challenge arrives asynchronously right after the
   * socket opens, so poll briefly for it.
   */
  private async ensureConnectedAndAuthed(url: string): Promise<void> {
    const relay = await this.pool.ensureRelay(url, { connectionTimeout: CONNECT_TIMEOUT_MS });
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
    //
    // With a set, "connected" means at least one answered. A relay that's
    // down at boot is reported and then handled by the watchdog like any
    // other outage, rather than holding up the other three.
    const results = await Promise.allSettled(this.urls.map((url) => this.ensureConnectedAndAuthed(url)));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        this.options.onError?.(new Error(`relay ${this.urls[index]}: ${errText(result.reason)}`));
      }
    }
    if (results.some((r) => r.status === "fulfilled")) {
      this.wasConnected = true;
      this.options.onConnect?.();
    }
    this.reportHealth();
    this.startWatchdog();
  }

  /** Fire onRelayHealth only when the picture actually changed. */
  private reportHealth(): void {
    const health = this.health();
    const signature = health.map((h) => `${h.url}:${h.connected}`).join("|");
    if (signature === this.lastHealthy) return;
    this.lastHealthy = signature;
    this.options.onRelayHealth?.(health);
  }

  private startWatchdog(): void {
    if (this.watchdog || this.closed) return;
    this.watchdog = setInterval(() => void this.checkLiveness(), this.options.watchdogMs ?? WATCHDOG_MS);
    // Never hold the process open: one-shot CLI commands must be able to exit.
    this.watchdog.unref?.();
  }

  /**
   * Repair the relay set.
   *
   * The single-relay version asked "are we connected?" and did nothing
   * when the answer was yes. With a set that is the bug: three relays
   * where two are dead answers yes, so the two never come back and the
   * client spends the week on one relay while reporting healthy. So we
   * repair every relay that is down, every tick, whether or not any
   * other relay is up.
   */
  private async checkLiveness(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    const before = this.connectedUrls();
    const down = this.urls.filter((url) => !before.has(url));

    if (down.length === 0) {
      if (!this.wasConnected) {
        this.wasConnected = true;
        this.options.onConnect?.();
      }
      this.reportHealth();
      return;
    }

    if (before.size === 0 && this.wasConnected) {
      this.wasConnected = false;
      this.options.onDisconnect?.();
    }
    // Nothing to restore and nothing listening: publish/query connect on
    // demand, so don't hold sockets open for an idle one-shot command.
    if (this.tracked.size === 0 && before.size === 0) {
      this.reportHealth();
      return;
    }

    this.reconnecting = true;
    try {
      // re-auth per relay before resubscribing on gated relays
      await Promise.allSettled(down.map((url) => this.ensureConnectedAndAuthed(url)));
      const after = this.connectedUrls();
      // Re-issue when the set GREW: a returning relay has no
      // subscriptions of its own, and the seen-set drops the replay the
      // relays that never left will send again.
      const recovered = [...after].some((url) => !before.has(url));
      if (recovered && this.tracked.size > 0) {
        for (const sub of this.tracked.values()) this.issue(sub);
      }
      if (after.size > 0 && !this.wasConnected) {
        this.wasConnected = true;
        this.options.onConnect?.();
      }
    } catch {
      // still down — next watchdog tick retries
    } finally {
      this.reconnecting = false;
      this.reportHealth();
    }
  }

  /**
   * Add relays at runtime — how a community's own relay list takes
   * effect without a restart. Existing subscriptions are re-issued so
   * the new relay starts answering them immediately.
   */
  addRelays(urls: string[]): void {
    const fresh = normalizeUrls(urls).filter((url) => !this.urls.includes(url));
    if (fresh.length === 0) return;
    this.urls = [...this.urls, ...fresh];
    for (const sub of this.tracked.values()) this.issue(sub);
    this.startWatchdog();
    void this.checkLiveness();
  }

  /**
   * Replace the whole set at runtime — the live-reload seam. Diffs
   * against the current set so an unchanged relay keeps its sockets;
   * an empty next set is refused (a service with no relay is deaf, and
   * deaf-by-config-error must fail loudly, not quietly).
   */
  setRelays(urls: string[]): void {
    const next = normalizeUrls(urls);
    if (next.length === 0) throw new Error("refusing an empty relay set");
    this.addRelays(next.filter((url) => !this.urls.includes(url)));
    const doomed = this.urls.filter((url) => !next.includes(url));
    if (doomed.length > 0) this.removeRelays(doomed);
  }

  /** Drop relays at runtime. Removing the last one is refused. */
  removeRelays(urls: string[]): void {
    const doomed = normalizeUrls(urls).filter((url) => this.urls.includes(url));
    if (doomed.length === 0) return;
    const remaining = this.urls.filter((url) => !doomed.includes(url));
    if (remaining.length === 0) throw new Error("refusing to remove the last relay");
    this.urls = remaining;
    this.pool.close(doomed);
    for (const sub of this.tracked.values()) this.issue(sub);
    this.reportHealth();
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
      // Every relay in the set, one subscription. The per-sub seen-set
      // makes the union deduped: an event on all four arrives once.
      this.pool.subscribeMany(this.urls, filter, {
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
    this.pool.close(this.urls);
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
    // The UNION across the relay set, deduped by id. An event that only
    // ever reached one relay is still an event that happened — dropping
    // it because the others don't have it would make the set weaker than
    // any single relay in it.
    const results = await Promise.all(
      filters.map((filter) => this.pool.querySync(this.urls, filter, { maxWait: timeoutMs }))
    );
    const byId = new Map<string, Event>();
    for (const events of results) {
      for (const event of events) byId.set(event.id, event);
    }
    return Array.from(byId.values());
  }

  /**
   * Publish a signed event to every relay in the set, awaiting their OKs.
   *
   * Succeeds when ANY relay accepts. Requiring all of them would hand a
   * veto to the least reliable relay on the list and make adding a relay
   * a liability rather than insurance — the opposite of the point. A
   * relay that rejects while another accepts is reported through onError
   * and otherwise ignored: the event is published, and a client that
   * threw there would be lying to the user about it.
   *
   * pool.publish returns Promise[] (one per relay) — awaiting the bare
   * array resolves immediately without waiting for (or surfacing) the
   * actual sends. Bit us live: a short-lived process exited before its
   * events reached the relay, silently.
   *
   * Transient total failures (drop, timeout, refused) retry across the
   * reconnect window; if every relay rejected on POLICY, that is a
   * verdict rather than an outage and retrying it is noise.
   */
  async publish(event: Event): Promise<void> {
    let errors: unknown[] = [];
    for (let attempt = 0; attempt <= PUBLISH_RETRY_DELAYS_MS.length; attempt++) {
      const results = await Promise.allSettled(this.pool.publish(this.urls, event));
      // A fulfilled promise is NOT an acceptance. nostr-tools returns
      // connection failures as a resolved STRING ("connection failure:
      // …") rather than rejecting, so counting fulfilments reports a
      // publish to a relay that does not exist as a success — verified
      // against a refused port, a dead TLS port, and an unresolvable
      // host, all of which "succeeded" in single-digit milliseconds.
      // For a system whose entire promise is that a signed event was
      // recorded somewhere, that is the worst possible lie to tell.
      const accepted = results.filter((r) => r.status === "fulfilled" && !isFailureValue(r.value)).length;
      errors = results.flatMap((r) =>
        r.status === "rejected" ? [r.reason] : isFailureValue(r.value) ? [new Error(String(r.value))] : []
      );

      if (accepted > 0) {
        if (errors.length > 0) {
          this.options.onError?.(
            new Error(
              `event ${event.id.slice(0, 8)} reached ${accepted}/${this.urls.length} relays: ${errors
                .map(errText)
                .join("; ")}`
            )
          );
        }
        return;
      }
      // Nobody took it. Only an outage is worth retrying.
      if (!errors.some(isTransientPublishError)) break;
      if (attempt < PUBLISH_RETRY_DELAYS_MS.length) await sleep(PUBLISH_RETRY_DELAYS_MS[attempt]);
    }
    const detail = errors.map(errText).join("; ") || "no relay accepted the event";
    throw new Error(`publish failed on all ${this.urls.length} relay(s): ${detail}`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Did this "successful" publish actually fail?
 *
 * nostr-tools resolves rather than rejects when it cannot reach a relay,
 * handing back the reason as a plain string. That is a library choice we
 * have to decode, not a contract we can rely on staying put — so the
 * eval for this asserts the BEHAVIOUR (publishing into the void throws),
 * which keeps failing if the string ever changes.
 */
function isFailureValue(value: unknown): boolean {
  return typeof value === "string" && /^connection (failure|skipped)/i.test(value);
}

/** Dedupe + normalize so the pool's map keys and ours are the same strings. */
function normalizeUrls(urls: string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) continue;
    let url: string;
    try {
      url = normalizeURL(trimmed);
    } catch {
      continue; // an unparseable relay is a typo, not a reason to fail boot
    }
    if (!out.includes(url)) out.push(url);
  }
  return out;
}
