import { describe, it, expect } from "vitest";
import { parseTtl, checkUp } from "../../fez-lium/src/guards.js";

/**
 * The money path of fez-lium: everything that refuses a GPU rent before
 * the network is touched. Pure functions — mcp.ts feeds them numbers.
 */

describe("parseTtl", () => {
  it("reads hours and minutes", () => {
    expect(parseTtl("2h")).toBe(2);
    expect(parseTtl("30m")).toBe(0.5);
    expect(parseTtl("1.5h")).toBe(1.5);
    expect(parseTtl(" 90M ")).toBe(1.5);
  });
  it("rejects what it can't read", () => {
    for (const bad of ["", "2", "h", "-1h", "0m", "2 hours", "1d"]) {
      expect(parseTtl(bad), bad).toBeNull();
    }
  });
});

describe("checkUp", () => {
  const ok = { priceUsdHour: 2, balanceUsd: 10, ttlHours: 1, maxUsdHour: 5, maxTtlHours: 4 };

  it("lets an affordable rent through", () => {
    expect(checkUp(ok)).toBeNull();
  });
  it("refuses over the price ceiling", () => {
    expect(checkUp({ ...ok, priceUsdHour: 6 })).toMatch(/\$6\/h.*\$5\/h/);
  });
  it("refuses over the ttl cap", () => {
    expect(checkUp({ ...ok, ttlHours: 5 })).toMatch(/5h.*4h cap/);
  });
  it("refuses when the balance can't carry the full lease", () => {
    // $2/h × 3h = $6 lease against a $5 balance
    expect(checkUp({ ...ok, ttlHours: 3, balanceUsd: 5 })).toMatch(/\$6\.00.*\$5\.00/);
  });
  it("fails closed on unreadable money", () => {
    expect(checkUp({ ...ok, priceUsdHour: null })).toMatch(/price/);
    expect(checkUp({ ...ok, balanceUsd: null })).toMatch(/balance/);
  });
  it("checks the ttl cap before needing a price", () => {
    expect(checkUp({ ...ok, ttlHours: 5, priceUsdHour: null })).toMatch(/cap/);
  });
});
