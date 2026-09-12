import type { Event, Filter } from "nostr-tools";

/** Nostr uses inclusive second-resolution cursors. Re-read the boundary with
 * a growing limit rather than skipping other events with that timestamp. */
export async function workHistory(
  query: (filters: Filter[]) => Promise<{ events: Event[]; failures: { reason: string }[] }>,
  filter: Filter,
  receive: (event: Event) => Promise<void>,
): Promise<void> {
  let until = filter.until;
  let limit = 200;
  const seen = new Set<string>();
  let saturated = false;
  for (;;) {
    const page = await query([{ ...filter, ...(until === undefined ? {} : { until }), limit }]);
    if (page.failures.length) throw new Error(`Work recovery incomplete: ${page.failures.map(f => f.reason).join(", ")}`);
    const events = page.events.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, limit);
    if (limit > 200 && events.length >= 200 && events.every(event => seen.has(event.id))) {
      throw new Error("Work history appears capped at a saturated timestamp; checkpoint retained");
    }
    // ponytail: EOSE cannot distinguish a complete dense second from a relay
    // cap. Deliver expanded pages, but never certify a second with >=200
    // events. Opaque relay caps below200 remain undetectable without relay metadata.
    saturated ||= events.length >= 200 && events[0].created_at === events[199].created_at;
    for (const event of events) if (!seen.has(event.id)) { await receive(event); seen.add(event.id); }
    if (events.length < limit) {
      if (saturated) throw new Error("Work history may be capped at a saturated timestamp; checkpoint retained");
      return;
    }
    const oldest = events.at(-1)!.created_at;
    if (oldest === until) {
      if (limit >= 12800) throw new Error("Work history has too many events in one second; checkpoint retained");
      limit *= 2;
    } else { until = oldest; limit = 200; }
  }
}
