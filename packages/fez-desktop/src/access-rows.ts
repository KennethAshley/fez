/**
 * The rows the allowlist picker offers.
 *
 * knownNames() only holds kind-0 profiles and agent announcements — the
 * people the allowlist exists FOR (guests: foreign npubs from a market
 * relay) live in the guest ledger and never reach it. Ken hit this live:
 * the picker offered his own agents (already admitted as siblings, so
 * ticking them changes nothing) and not lebron, the one outsider he
 * wanted to admit.
 *
 * Rules, in order:
 * - workspace names first, then guests (deduped — a guest who later
 *   publishes a profile shows once, as the workspace name)
 * - a pubkey already ON the allowlist always gets a row, even if nothing
 *   can name it — a ticked box that isn't rendered can never be unticked
 */
export interface AccessRow {
  pk: string;
  name: string;
  /** Rendered as a "guest" tag so an outsider reads as one. */
  guest?: boolean;
}

export function accessRows(
  known: ReadonlyArray<[string, string]>,
  guests: ReadonlyArray<{ pk: string; name?: string }>,
  allowlisted: ReadonlyArray<string>
): AccessRow[] {
  const rows: AccessRow[] = [];
  const seen = new Set<string>();
  for (const [pk, name] of known) {
    if (seen.has(pk)) continue;
    seen.add(pk);
    rows.push({ pk, name });
  }
  for (const g of guests) {
    if (seen.has(g.pk)) continue;
    seen.add(g.pk);
    rows.push({ pk: g.pk, name: g.name ?? `${g.pk.slice(0, 8)}…`, guest: true });
  }
  for (const pk of allowlisted) {
    if (seen.has(pk)) continue;
    seen.add(pk);
    rows.push({ pk, name: `${pk.slice(0, 8)}…` });
  }
  return rows;
}
