import { type Filter, type Event } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";

export interface RelayOptions {
  url: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Lightweight relay connection wrapper.
 * Uses nostr-tools SimplePool for pub/sub.
 */
export class RelayConnection {
  private pool: SimplePool;
  private url: string;
  private subs: Map<string, { close: () => void }> = new Map();

  constructor(private options: RelayOptions) {
    this.url = options.url;
    this.pool = new SimplePool();
  }

  async connect(): Promise<void> {
    // SimplePool lazily connects on first use
    this.options.onConnect?.();
  }

  disconnect(): void {
    this.subs.forEach((sub) => sub.close());
    this.subs.clear();
    // SimplePool auto-manages connections
  }

  /**
   * Subscribe to events matching any of the given filters (OR semantics).
   * Returns a function to unsubscribe.
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
    const seen = new Set<string>();
    let eoseCount = 0;

    const subs = filters.map((filter) =>
      this.pool.subscribeMany([this.url], filter, {
        onevent: (event) => {
          if (seen.has(event.id)) return;
          seen.add(event.id);
          onEvent(event);
        },
        oneose: () => {
          eoseCount++;
          if (eoseCount === filters.length) onEose?.();
        },
      })
    );

    const id = Math.random().toString(36).slice(2);
    const close = () => subs.forEach((sub) => sub.close());
    this.subs.set(id, { close });

    return () => {
      close();
      this.subs.delete(id);
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
   * Publish a signed event to the relay.
   */
  async publish(event: Event): Promise<void> {
    // pool.publish returns Promise[] (one per relay) — awaiting the bare
    // array resolves immediately without waiting for (or surfacing) the
    // actual sends. Bit us live: a short-lived process exited before its
    // events reached the relay, silently.
    await Promise.all(this.pool.publish([this.url], event));
  }
}
