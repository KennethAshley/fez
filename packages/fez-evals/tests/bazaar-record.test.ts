import { describe, it, expect } from "vitest";
import { aggregateRecord, BAZAAR_VALIDATORS } from "../../fez-desktop/src/bazaar-record.js";

const VALIDATOR = BAZAAR_VALIDATORS[0]!;
const att = (over: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => ({
  id: "e1", pubkey: VALIDATOR, kind: 47020, created_at: 1000,
  content: JSON.stringify({ quality: 0.8, conduct: 1, timeliness: 0.9, total: 0.85, injected: false, rank: 1, cohort: 4, ...body }),
  tags: [["e", "t", "", "root"], ["p", "agent"], ["rubric", "research-citations/v2"], ["task_type", "research"]],
  ...over,
});

describe("aggregateRecord", () => {
  it("groups by task type with a percentile from rank/cohort", () => {
    const rows = aggregateRecord([att(), att({ id: "e2", created_at: 2000 }, { rank: 2 })], "agent");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskType).toBe("research");
    expect(rows[0]!.count).toBe(2);
    // ranks 1 and 2 of 4 → (4-1)/3 = 1.0 and (4-2)/3 = .667 → mean ≈ 83
    expect(rows[0]!.percentile).toBe(83);
    expect(rows[0]!.lastAt).toBe(2000);
  });
  it("ignores non-validators and unparseable rows", () => {
    expect(
      aggregateRecord([att({ pubkey: "ff".repeat(32) }), att({ content: "not json" })], "agent"),
    ).toHaveLength(0);
  });
  it("v1 rows without cohort still count, without a percentile claim", () => {
    const rows = aggregateRecord([att({}, { cohort: undefined })], "agent");
    expect(rows[0]!.count).toBe(1);
    expect(rows[0]!.percentile).toBeUndefined();
  });
  it("ignores an attestation p-tagged to a different agent", () => {
    const rows = aggregateRecord(
      [att({ tags: [["e", "t", "", "root"], ["p", "someone-else"], ["rubric", "research-citations/v2"], ["task_type", "research"]] })],
      "agent",
    );
    expect(rows).toHaveLength(0);
  });
  it("ignores a wrong-kind event even if p-tagged correctly", () => {
    const rows = aggregateRecord([att({ kind: 1 })], "agent");
    expect(rows).toHaveLength(0);
  });
});
