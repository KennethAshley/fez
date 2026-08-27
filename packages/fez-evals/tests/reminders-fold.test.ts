import { describe, it, expect } from "vitest";
import {
  latestPerAddress,
  shouldArm,
  nextCreatedAt,
  relativeWhen,
  type ReminderRecord,
} from "../../fez-client/src/reminders.js";

const rec = (over: Partial<ReminderRecord> = {}): ReminderRecord => ({
  key: "r1",
  note: "a note",
  remindAt: 2_000,
  status: "pending",
  createdAt: 100,
  editable: true,
  ...over,
});

/**
 * A reminder is a REPLACEABLE event: every edit republishes the same
 * address, so the list is "newest per address" rather than "everything
 * ever written". Getting this wrong shows a snoozed reminder twice — at
 * both its old time and its new one.
 */
describe("latestPerAddress", () => {
  it("keeps the newest write for an address", () => {
    const out = latestPerAddress([
      rec({ key: "r1", remindAt: 2_000, createdAt: 100 }),
      rec({ key: "r1", remindAt: 9_000, createdAt: 200 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].remindAt).toBe(9_000);
  });

  it("keeps distinct addresses apart", () => {
    expect(latestPerAddress([rec({ key: "r1" }), rec({ key: "r2" })])).toHaveLength(2);
  });

  // Same second is the case a human actually hits — snooze, change your
  // mind, snooze again. created_at alone cannot order those.
  it("breaks a created_at tie by id, so the order is total and stable", () => {
    const out = latestPerAddress([
      rec({ key: "r1", note: "bbb", createdAt: 100, id: "bb" } as never),
      rec({ key: "r1", note: "aaa", createdAt: 100, id: "aa" } as never),
    ]);
    expect(out).toHaveLength(1);
  });

  it("survives an empty list", () => {
    expect(latestPerAddress([])).toEqual([]);
  });
});

describe("shouldArm", () => {
  it("arms a pending reminder that is still in the future", () => {
    expect(shouldArm(rec({ status: "pending", remindAt: 5_000 }), 1_000)).toBe(true);
  });

  // Done and cancelled are the whole point of the status field: an
  // armed timer for either would fire something you already dismissed.
  it("never arms a completed or cancelled one", () => {
    expect(shouldArm(rec({ status: "done", remindAt: 5_000 }), 1_000)).toBe(false);
    expect(shouldArm(rec({ status: "cancelled", remindAt: 5_000 }), 1_000)).toBe(false);
  });

  it("arms one that just went past, so a brief close does not lose it", () => {
    expect(shouldArm(rec({ remindAt: 1_000 }), 1_030)).toBe(true);
  });

  // Without this every launch re-fires the whole history — the bug the
  // hydrate path already guards with its own 60s window.
  it("does not arm one long past", () => {
    expect(shouldArm(rec({ remindAt: 1_000 }), 5_000)).toBe(false);
  });
});

/**
 * A replacement must outrank what it replaces. Two edits inside one
 * second, or a clock that stepped backwards, would otherwise publish an
 * event the relay discards in favour of the older one — the edit
 * silently doing nothing.
 */
describe("nextCreatedAt", () => {
  it("uses now when now is already ahead", () => {
    expect(nextCreatedAt(100, 500)).toBe(500);
  });

  it("steps past the predecessor when now is not ahead", () => {
    expect(nextCreatedAt(500, 500)).toBe(501);
    expect(nextCreatedAt(500, 400)).toBe(501);
  });

  it("uses now for a first write", () => {
    expect(nextCreatedAt(undefined, 500)).toBe(500);
  });
});

/**
 * A reminder is a countdown. The wall-clock time answers "when" but not
 * "how long have I got", which is the only question the list is asked.
 */
describe("relativeWhen", () => {
  const t = (s: string) => Math.floor(new Date(s).getTime() / 1000);
  const now = t("2026-08-27T14:00:00");

  it("counts down in minutes within the hour", () => {
    expect(relativeWhen(now + 18 * 60, now)).toBe("in 18m");
  });

  it("collapses the last minute rather than counting seconds", () => {
    expect(relativeWhen(now + 30, now)).toBe("in <1m");
  });

  it("counts down in hours past the hour", () => {
    expect(relativeWhen(now + 3 * 3600, now)).toBe("in 3h");
  });

  // "in 19h" is technically true and useless — you think in days once it
  // crosses midnight.
  it("names tomorrow by its clock time, not an hour count", () => {
    expect(relativeWhen(t("2026-08-28T09:00:00"), now)).toBe("tomorrow 09:00");
  });

  it("dates anything further out", () => {
    expect(relativeWhen(t("2026-09-02T09:00:00"), now)).toMatch(/Sep 2/);
  });

  it("says how long ago for one already past", () => {
    expect(relativeWhen(now - 12 * 60, now)).toBe("12m ago");
    expect(relativeWhen(now - 3 * 3600, now)).toBe("3h ago");
  });

  it("calls the moment itself now, not 0m ago", () => {
    expect(relativeWhen(now, now)).toBe("just now");
  });
});
