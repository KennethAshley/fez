import { describe, it, expect } from "vitest";
import { parseHireProposal } from "../../fez-desktop/src/hire-proposal";

const good = JSON.stringify({
  task: "Summarize RFC 9114 with citations",
  pk: "d".repeat(64), name: "lebron",
  why: "nobody on the roster claims cited research",
  kind: "settle", price_est_tao: 0.13, rate_tao_hr: 0.5,
});

describe("parseHireProposal", () => {
  it("parses a well-formed block", () => {
    const p = parseHireProposal(good)!;
    expect(p.name).toBe("lebron");
    expect(p.kind).toBe("settle");
    expect(p.priceEstTao).toBeCloseTo(0.13);
  });
  it("rejects a bad pk", () => {
    expect(parseHireProposal(good.replace("d".repeat(64), "nope"))).toBeUndefined();
  });
  it("rejects an unknown kind", () => {
    expect(parseHireProposal(good.replace("settle", "wire-me-money"))).toBeUndefined();
  });
  it("rejects non-JSON without throwing", () => {
    expect(parseHireProposal("{ not json")).toBeUndefined();
  });
  it("rejects a missing task or why", () => {
    const noWhy = JSON.parse(good); delete noWhy.why;
    expect(parseHireProposal(JSON.stringify(noWhy))).toBeUndefined();
  });
});
