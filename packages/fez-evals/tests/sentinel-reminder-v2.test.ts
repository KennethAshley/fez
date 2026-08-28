import { describe, it, expect } from "vitest";
import { decodeReminderV2 } from "../../fez-sentinel/src/reminders-v2.js";

/**
 * The sentinel is the app-closed deliverer, and reminders moved to kind
 * 30176 (replaceable, addressed by `d`, status in the encrypted body)
 * while the sentinel still spoke only 40007 — so a sentinel user's
 * reminders fired nowhere: the desktop defers to the sentinel and the
 * sentinel never saw the event. This decoder is the sentinel's v2 half,
 * pure so the shape rules are testable without a relay.
 */

const ev = (tags: string[][], body: unknown) => ({
  tags,
  content: JSON.stringify(body),
});
const plain = (c: string) => c; // decrypt: identity, like the client's fake wire

describe("decodeReminderV2", () => {
  it("decodes a pending reminder to its address, note and time", () => {
    const r = decodeReminderV2(ev([["d", "r1"]], { note: "stretch", remind_at: 1000, status: "pending" }), plain);
    expect(r).toEqual({ address: "r1", note: "stretch", at: 1000, live: true });
  });

  it("done and cancelled decode as not-live so the arm site can disarm", () => {
    for (const status of ["done", "cancelled"]) {
      const r = decodeReminderV2(ev([["d", "r1"]], { note: "x", remind_at: 1000, status }), plain);
      expect(r?.live, status).toBe(false);
    }
  });

  it("an empty note still says something", () => {
    const r = decodeReminderV2(ev([["d", "r1"]], { remind_at: 1000 }), plain);
    expect(r?.note).toBe("(reminder)");
  });

  it("no address, no remind_at, bad json and a failing decrypt all decode to null", () => {
    expect(decodeReminderV2(ev([], { remind_at: 1000 }), plain)).toBeNull();
    expect(decodeReminderV2(ev([["d", "r1"]], { note: "x" }), plain)).toBeNull();
    expect(decodeReminderV2({ tags: [["d", "r1"]], content: "not json" }, plain)).toBeNull();
    expect(
      decodeReminderV2(ev([["d", "r1"]], { remind_at: 1000 }), () => {
        throw new Error("not ours");
      })
    ).toBeNull();
  });
});
