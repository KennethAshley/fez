import { describe, it, expect } from "vitest";
import { nextStep, prevStep } from "../../fez-desktop/src/onboarding-steps.js";

describe("onboarding step order", () => {
  it("walks the locked order forward", () => {
    const walk = ["welcome", "harness", "defaults", "community", "profile", "team"];
    for (let i = 0; i < walk.length - 1; i++) expect(nextStep(walk[i] as never)).toBe(walk[i + 1]);
    // "team" is the last step — Buzz's flow ends there, no "done" after it.
    expect(nextStep("team" as never)).toBe("team");
  });
  it("back retraces it", () => {
    expect(prevStep("defaults" as never)).toBe("harness");
    expect(prevStep("team" as never)).toBe("profile");
    expect(prevStep("welcome" as never)).toBe("welcome");
  });
});
