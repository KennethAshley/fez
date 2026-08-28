/**
 * The sentinel's half of v2 reminders (kind 30176) — pure, so the shape
 * rules are testable without a relay.
 *
 * A v2 reminder is REPLACEABLE at (pubkey, 30176, d): snooze, complete
 * and cancel are republishes to the same address with a different body,
 * so the newest write per address is the whole truth. The body rides
 * NIP-44 self-encrypted (private data on a public relay); the sentinel
 * runs with the owner's key and decrypts to arm. Mirrors the reading
 * half of fez-client's putReminder/armReminder — the two deliverers
 * must parse one event the same way.
 */

export interface DecodedReminderV2 {
  /** The `d` address — the timer key, because an edit supersedes it. */
  address: string;
  note: string;
  /** Seconds. */
  at: number;
  /** False for done/cancelled: the arm site disarms instead of arming. */
  live: boolean;
}

export function decodeReminderV2(
  event: { content: string; tags: string[][] },
  decrypt: (content: string) => string,
): DecodedReminderV2 | null {
  const address = event.tags.find((t) => t[0] === "d")?.[1];
  if (!address) return null;
  let body: { note?: string; remind_at?: number; status?: string };
  try {
    body = JSON.parse(decrypt(event.content)) as typeof body;
  } catch {
    return null;
  }
  if (typeof body.remind_at !== "number") return null;
  return {
    address,
    note: body.note || "(reminder)",
    at: body.remind_at,
    live: body.status !== "done" && body.status !== "cancelled",
  };
}
