/**
 * Reminder folding — the pure half, testable without a wire.
 *
 * A reminder is a REPLACEABLE event (kind 30176, addressed by its `d`
 * tag), so an edit is a republish to the same address rather than a new
 * row: snooze, complete and cancel are one operation with a different
 * body. That makes "the list" a fold — newest write per address — and
 * makes cancellation a state rather than a tombstone.
 *
 * Legacy 40007 reminders are regular events with no address and no
 * status. They fold in as their own key and are marked `editable: false`:
 * they can still be listed and still fire, but there is nothing to
 * republish over, so the three actions do not apply to them.
 */

export type ReminderStatus = "pending" | "done" | "cancelled";

/** The decrypted body, as written into the event's content. */
export interface ReminderBody {
  note?: string;
  remind_at?: number;
  about?: string;
  status?: ReminderStatus;
}

export interface ReminderRecord {
  /** The `d` address for a 30176; the event id for a legacy 40007. */
  key: string;
  note: string;
  /** Seconds. */
  remindAt: number;
  /** The message this is about, if any. */
  about?: string;
  status: ReminderStatus;
  createdAt: number;
  /** False for legacy 40007s — no address to republish over. */
  editable: boolean;
  /** Event id, for ordering ties and for deleting a legacy one. */
  id?: string;
}

/**
 * How late is still worth firing. A reminder that came due while the app
 * was closed for a moment deserves to arrive; one from last week does
 * not, or every launch re-announces the whole history.
 */
export const STALE_AFTER_S = 60;

/**
 * Newest write per address. Ties on `created_at` break by event id so the
 * order is total — two edits inside one second is the case a human
 * actually produces, and without a tiebreak the winner is whichever the
 * relay happened to return first.
 */
export function latestPerAddress(records: ReminderRecord[]): ReminderRecord[] {
  const byKey = new Map<string, ReminderRecord>();
  for (const record of records) {
    const held = byKey.get(record.key);
    if (!held) {
      byKey.set(record.key, record);
      continue;
    }
    const newer =
      record.createdAt > held.createdAt ||
      (record.createdAt === held.createdAt && (record.id ?? "") > (held.id ?? ""));
    if (newer) byKey.set(record.key, record);
  }
  return [...byKey.values()];
}

/** Should this reminder get a timer? */
export function shouldArm(record: ReminderRecord, nowS: number): boolean {
  if (record.status !== "pending") return false;
  return record.remindAt > nowS - STALE_AFTER_S;
}

/**
 * A `created_at` that always outranks what it replaces. Relays keep the
 * newest event at an address, so an edit in the same second — or after a
 * clock step backwards — would otherwise be discarded in favour of the
 * event it was meant to replace, and the edit would silently do nothing.
 */
export function nextCreatedAt(previousCreatedAt: number | undefined, nowS: number): number {
  if (previousCreatedAt === undefined) return nowS;
  return Math.max(nowS, previousCreatedAt + 1);
}

/**
 * How long until — the only question a reminder list is asked.
 *
 * A wall-clock time tells you WHEN and leaves you to do the arithmetic;
 * "in 18m" is the thing you actually wanted. The units coarsen as the
 * distance grows because that is how the answer stops being useful:
 * minutes matter within the hour, hours within the day, and past
 * midnight you think in days and clock times instead ("in 19h" is true
 * and no help). The exact timestamp stays available on hover.
 */
export function relativeWhen(remindAt: number, nowS: number): string {
  const delta = remindAt - nowS;
  const at = new Date(remindAt * 1000);
  const clock = () =>
    at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

  if (Math.abs(delta) < 30) return "just now";

  if (delta > 0) {
    if (delta < 60) return "in <1m";
    if (delta < 3600) return `in ${Math.round(delta / 60)}m`;
    // Same calendar day: hours still read naturally.
    const sameDay = at.toDateString() === new Date(nowS * 1000).toDateString();
    if (sameDay) return `in ${Math.round(delta / 3600)}h`;
    const tomorrow = new Date(nowS * 1000);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (at.toDateString() === tomorrow.toDateString()) return `tomorrow ${clock()}`;
    return `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock()}`;
  }

  const past = -delta;
  if (past < 3600) return `${Math.round(past / 60)}m ago`;
  if (past < 86_400) return `${Math.round(past / 3600)}h ago`;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock()}`;
}
