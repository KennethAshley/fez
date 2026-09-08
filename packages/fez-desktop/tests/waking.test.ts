import { describe, expect, test } from "vitest";
import { markWaking, clearWaking, wakingSince, wakeLabel, WAKE_STALL_MS } from "../src/waking.js";

describe("the waking window", () => {
  test("mark → label → clear round-trips, case-insensitively", () => {
    markWaking("Dubois", 1000);
    expect(wakingSince("dubois")).toBe(1000);
    expect(wakeLabel("DUBOIS", 2000)?.stalled).toBe(false);
    clearWaking("duBois");
    expect(wakeLabel("dubois", 2000)).toBeUndefined();
  });

  test("goes stalled after WAKE_STALL_MS, not before", () => {
    markWaking("dubois", 0);
    expect(wakeLabel("dubois", WAKE_STALL_MS)?.stalled).toBe(false);
    expect(wakeLabel("dubois", WAKE_STALL_MS + 1)?.stalled).toBe(true);
    clearWaking("dubois");
  });

  test("an agent nobody marked has no label", () => {
    expect(wakeLabel("stranger")).toBeUndefined();
  });
});
