/**
 * The money path, pure and testable: everything that can refuse a rent
 * BEFORE the network is touched (the ridges rule). mcp.ts feeds it
 * numbers; this decides. No I/O here.
 */

export const DEFAULT_MAX_USD_HOUR = 5;
export const DEFAULT_TTL = "1h";
export const DEFAULT_MAX_TTL_HOURS = 4;

/** "2h" | "90m" | "1.5h" → hours, or null if unparseable. */
export function parseTtl(ttl: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(h|m)$/i.exec(ttl.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].toLowerCase() === "h" ? n : n / 60;
}

export interface UpCheck {
  /** $/hour of the node; null = we couldn't read it from `lium ls`. */
  priceUsdHour: number | null;
  /** Account balance in USD; null = we couldn't read it. */
  balanceUsd: number | null;
  ttlHours: number;
  maxUsdHour: number;
  maxTtlHours: number;
}

/**
 * Returns a plain refusal sentence naming the number that blocked it,
 * or null when the rent may proceed. Unreadable price/balance refuses —
 * fail closed on money.
 */
export function checkUp(c: UpCheck): string | null {
  if (c.ttlHours > c.maxTtlHours)
    return `refused: ttl ${c.ttlHours}h exceeds the ${c.maxTtlHours}h cap (FEZ_LIUM_MAX_TTL raises it).`;
  if (c.priceUsdHour === null)
    return "refused: couldn't read this node's hourly price from `lium ls` — not renting blind.";
  if (c.priceUsdHour > c.maxUsdHour)
    return `refused: $${c.priceUsdHour}/h exceeds the $${c.maxUsdHour}/h ceiling (FEZ_LIUM_MAX_USD_HOUR raises it).`;
  if (c.balanceUsd === null)
    return "refused: couldn't read the account balance — not renting blind.";
  const lease = c.priceUsdHour * c.ttlHours;
  if (c.balanceUsd < lease)
    return `refused: the full lease costs $${lease.toFixed(2)} but the balance holds $${c.balanceUsd.toFixed(2)} — top up first (lium_topup).`;
  return null;
}
