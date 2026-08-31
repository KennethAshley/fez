import { describe, it, expect } from "vitest";
import { CAPABLE_FEZ_PERSONA } from "../../../src/identity/fez-persona";

// The DM git-install offer only works if the persona keeps teaching it —
// same guard style as the catalog list below it.
describe("guide persona: git install offers", () => {
  it("teaches the git marker form, DM-only", () => {
    expect(CAPABLE_FEZ_PERSONA).toContain("fez:install git:");
    expect(CAPABLE_FEZ_PERSONA).toMatch(/direct message|DM/);
  });
});
