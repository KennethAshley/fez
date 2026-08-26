import type { StoredEvent } from "./relay.js";
import { parseSealed } from "@fezchat/protocol";

/**
 * The timestamp escrow (de-sentinel workstream 3): watches sealed 40006
 * intents and, at send_at, INJECTS the embedded author-signed event
 * through the relay's normal ingest pipeline. It authors nothing — the
 * signature in the envelope is the author's, injection re-validates it,
 * and re-release after a restart is a no-op because relays dedupe by id.
 *
 * Legacy plaintext intents are deliberately NOT handled here: releasing
 * one would require signing as the author, which the relay must never
 * do. The sentinel remains their executor.
 *
 * Built into the relay (default-on, --no-scheduler to disable) but
 * written against the extension-API subset so it can move to a
 * standalone relay extension without change.
 */

const KIND_SCHEDULED = 40006;
const KIND_DELETION = 5;
const MAX_DELAY = 2 ** 31 - 1;

export interface SchedulerApi {
  query(filter: Record<string, unknown>): StoredEvent[];
  onEvent(cb: (event: StoredEvent) => void): void;
  inject(event: StoredEvent): Promise<{ accepted: boolean; reason?: string }>;
  log(line: string): void;
}

export function activateScheduler(api: SchedulerApi): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const done = new Set<string>();

  const disarm = (intentId: string) => {
    const t = timers.get(intentId);
    if (t) clearTimeout(t);
    timers.delete(intentId);
    done.add(intentId);
  };

  const fire = async (intent: StoredEvent) => {
    timers.delete(intent.id);
    if (done.has(intent.id)) return;

    // Re-arm for long delays beyond MAX_DELAY (2^31-1 ms = ~24.9 days)
    const at = Number(intent.tags.find((t) => t[0] === "send_at")?.[1]);
    const remaining = at * 1000 - Date.now();
    if (remaining > 1000) {
      // Still meaningfully in the future — re-arm in chunks
      const delayMs = Math.min(Math.max(0, remaining), MAX_DELAY);
      timers.set(intent.id, setTimeout(() => void fire(intent), delayMs));
      return;
    }

    done.add(intent.id);
    const inner = parseSealed(intent.content);
    if (!inner) return;
    const verdict = await api.inject(inner as StoredEvent);
    api.log(
      verdict.accepted
        ? `⏲ released sealed intent ${intent.id.slice(0, 8)}… → event ${inner.id.slice(0, 8)}…`
        : `⏲ sealed intent ${intent.id.slice(0, 8)}… not released (${verdict.reason ?? "refused"}) — likely already delivered`
    );
  };

  const arm = (intent: StoredEvent) => {
    if (done.has(intent.id) || timers.has(intent.id)) return;
    if (!parseSealed(intent.content)) return; // legacy plaintext — sentinel's job
    const at = Number(intent.tags.find((t) => t[0] === "send_at")?.[1]);
    if (!at) return;
    const delayMs = Math.min(Math.max(0, at * 1000 - Date.now()), MAX_DELAY);
    timers.set(intent.id, setTimeout(() => void fire(intent), delayMs));
  };

  // Tombstones count only from the intent's own author — anyone else's
  // kind 5 naming the id is noise (same author-only rule clients apply).
  const tombstonedIds = (events: StoredEvent[], intents: Map<string, StoredEvent>): Set<string> => {
    const dead = new Set<string>();
    for (const t of events) {
      for (const tag of t.tags) {
        if (tag[0] !== "e" || !tag[1]) continue;
        const intent = intents.get(tag[1]);
        if (intent && intent.pubkey === t.pubkey) dead.add(tag[1]);
      }
    }
    return dead;
  };

  const intents = new Map<string, StoredEvent>(
    api.query({ kinds: [KIND_SCHEDULED] }).map((e) => [e.id, e])
  );
  const dead = tombstonedIds(api.query({ kinds: [KIND_DELETION] }), intents);
  for (const [id, intent] of intents) {
    if (dead.has(id)) done.add(id);
    else arm(intent);
  }
  const armed = timers.size;
  if (armed > 0) api.log(`⏲ scheduler armed ${armed} sealed intent(s)`);

  api.onEvent((event) => {
    if (event.kind === KIND_SCHEDULED) {
      intents.set(event.id, event);
      arm(event);
      return;
    }
    if (event.kind === KIND_DELETION) {
      for (const tag of event.tags) {
        if (tag[0] !== "e" || !tag[1]) continue;
        const intent = intents.get(tag[1]);
        if (intent && intent.pubkey === event.pubkey) disarm(tag[1]);
      }
    }
  });
}
