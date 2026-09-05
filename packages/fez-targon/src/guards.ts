/**
 * The money path, pure and testable: everything that can refuse a rental
 * BEFORE the network is touched (the ridges rule). mcp.ts feeds it
 * numbers; this decides. No I/O here.
 *
 * Targon's difference from Lium: there is NO marketplace-enforced TTL.
 * Billing runs until the workload is deleted, so the only lease is the
 * prepaid balance itself — we refuse to start a rental the balance
 * couldn't run for at least MIN_RUNWAY_HOURS.
 */

export const DEFAULT_MAX_USD_HOUR = 5;
export const MIN_RUNWAY_HOURS = 1;

export interface UpCheck {
  /** $/hour of the resource; null = we couldn't read it from inventory. */
  priceUsdHour: number | null;
  /** Org credit balance in USD; null = we couldn't read it. */
  balanceUsd: number | null;
  maxUsdHour: number;
}

/**
 * Returns a plain refusal sentence naming the number that blocked it,
 * or null when the rental may proceed. Unreadable price/balance refuses —
 * fail closed on money.
 */
export function checkUp(c: UpCheck): string | null {
  if (c.priceUsdHour === null)
    return "refused: couldn't read this resource's hourly price from Targon's inventory — not renting blind.";
  if (c.priceUsdHour > c.maxUsdHour)
    return `refused: $${c.priceUsdHour}/h exceeds the $${c.maxUsdHour}/h ceiling (FEZ_TARGON_MAX_USD_HOUR raises it).`;
  if (c.balanceUsd === null)
    return "refused: couldn't read the org's credit balance — not renting blind.";
  if (c.balanceUsd < c.priceUsdHour * MIN_RUNWAY_HOURS)
    return `refused: $${c.balanceUsd.toFixed(2)} of credit buys less than ${MIN_RUNWAY_HOURS}h at $${c.priceUsdHour}/h — the human tops up at targon.com first.`;
  return null;
}
