import { describe, it, expect } from "vitest";
import { nextStep, prevStep, identityPlan, isStep } from "../../fez-desktop/src/onboarding-steps.js";

describe("onboarding step order", () => {
  it("walks the locked order forward", () => {
    const walk = ["welcome", "harness", "community", "profile", "team"];
    for (let i = 0; i < walk.length - 1; i++) expect(nextStep(walk[i] as never)).toBe(walk[i + 1]);
    // "team" is the last step — Buzz's flow ends there, no "done" after it.
    expect(nextStep("team" as never)).toBe("team");
  });
  it("back retraces it", () => {
    expect(prevStep("community")).toBe("harness");
    expect(nextStep("defaults")).toBe("community"); // resume an older wizard
    expect(prevStep("defaults")).toBe("welcome");
    expect(prevStep("team" as never)).toBe("profile");
    expect(prevStep("welcome" as never)).toBe("welcome");
  });
});

/**
 * "Get started" must be safe to click twice. set_identity REFUSES to
 * overwrite (an existing identity is never silently replaced from the
 * GUI), so backing out of the harness step and starting again used to
 * error every time — the wizard's main path soft-locked. The plan:
 * keep what this wizard already holds, adopt what the keychain holds,
 * and mint only when there is truly nothing.
 */
describe("identityPlan", () => {
  it("keeps the key this wizard already made", () => {
    expect(identityPlan("ab".repeat(32), undefined)).toEqual({ action: "keep" });
  });

  it("adopts a stored identity instead of minting a colliding second one", () => {
    expect(identityPlan(undefined, "AB".repeat(32) + "\n")).toEqual({
      action: "adopt",
      hex: "ab".repeat(32),
    });
  });

  it("mints only when nothing is held or stored", () => {
    expect(identityPlan(undefined, undefined)).toEqual({ action: "mint" });
    expect(identityPlan(undefined, "not a key")).toEqual({ action: "mint" });
  });
});

/**
 * isStep guards the wizard's persisted snapshot: the step name written
 * before a quit is read back on the next launch, so a renamed or removed
 * step (or garbage) must fall back to the front door, never crash the
 * resume into a step that no longer exists.
 */
describe("isStep", () => {
  it("accepts every real step, main flow and side doors", () => {
    for (const s of ["welcome", "harness", "defaults", "community", "profile", "team", "invite", "pairing", "restore", "reconnect"]) {
      expect(isStep(s)).toBe(true);
    }
  });

  it("rejects what a stale or corrupt snapshot could hold", () => {
    expect(isStep("done")).toBe(false); // never existed — Buzz's flow ends at team
    expect(isStep("")).toBe(false);
    expect(isStep(undefined)).toBe(false);
    expect(isStep(42)).toBe(false);
  });
});
