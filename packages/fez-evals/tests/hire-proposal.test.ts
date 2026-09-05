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
  it("rejects a missing task", () => {
    const noTask = JSON.parse(good); delete noTask.task;
    expect(parseHireProposal(JSON.stringify(noTask))).toBeUndefined();
  });
  it("rejects a task over the length cap", () => {
    const tooLong = { ...JSON.parse(good), task: "x".repeat(4001) };
    expect(parseHireProposal(JSON.stringify(tooLong))).toBeUndefined();
  });
  it("accepts a valid wss relay, omits an invalid one", () => {
    const withRelay = parseHireProposal(JSON.stringify({ ...JSON.parse(good), relay: "wss://miner-relay.example" }))!;
    expect(withRelay.relay).toBe("wss://miner-relay.example");
    const junkRelay = parseHireProposal(JSON.stringify({ ...JSON.parse(good), relay: "not a relay" }))!;
    expect(junkRelay.relay).toBeUndefined();
  });
});
