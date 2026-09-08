import { describe, expect, it } from "vitest";
import { parseJson, priceOf, matchesNode } from "../src/cli-lib.js";

describe("cli-lib pure helpers", () => {
  it("parseJson tolerates garbage", () => {
    expect(parseJson("{not json")).toBeNull();
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it("priceOf reads price_per_hour", () => {
    expect(priceOf({ price_per_hour: "1.5" })).toBe(1.5);
    expect(priceOf({})).toBeNull();
  });
  it("matchesNode matches index, id, or huid", () => {
    expect(matchesNode({ id: "abc" }, "abc")).toBe(true);
    expect(matchesNode({ index: 3 }, "3")).toBe(true);
    expect(matchesNode({}, "x")).toBe(false);
  });
});
