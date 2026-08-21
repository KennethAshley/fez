import { describe, expect, test } from "vitest";
import { capReply } from "../../fez-acp/src/bridge-policy.js";

/** The bridge cap is structural, not prompt-based — pin it. */
describe("capReply", () => {
  test("under the cap passes through untouched", () => {
    expect(capReply("short summary", 1200)).toBe("short summary");
  });
  test("no cap configured = no change", () => {
    expect(capReply("x".repeat(50_000), undefined)).toHaveLength(50_000);
  });
  test("over the cap truncates with a visible marker", () => {
    const out = capReply("a".repeat(5000), 1200);
    expect(out.startsWith("a".repeat(1200))).toBe(true);
    expect(out).toContain("✂ [capped at 1200 chars");
    expect(out.length).toBeLessThan(1300);
  });
  test("a dumped channel log cannot exceed the cap", () => {
    const dump = Array.from({ length: 500 }, (_, i) => `[10:0${i % 10}] user: secret line ${i}`).join("\n");
    const out = capReply(dump, 800);
    expect(out.length).toBeLessThan(900);
  });
});
