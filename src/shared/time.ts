/** Seconds since epoch — the resolution nostr `created_at` speaks. */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
