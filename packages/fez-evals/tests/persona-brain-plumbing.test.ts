import { describe, it, expect } from "vitest";
import { piThinkingLevel } from "../../fez-acp/src/thinking.js";
import { KNOWN_EXTRA_KEYS } from "../../../src/identity/personas.js";

describe("persona brain plumbing", () => {
  it("effort is a known persona key", () => {
    expect(KNOWN_EXTRA_KEYS).toContain("effort");
  });
  it("maps effort to pi thinking levels, rejecting junk", () => {
    expect(piThinkingLevel("low")).toBe("low");
    expect(piThinkingLevel("medium")).toBe("medium");
    expect(piThinkingLevel("high")).toBe("high");
    expect(piThinkingLevel("turbo")).toBeUndefined();
    expect(piThinkingLevel(undefined)).toBeUndefined();
  });
});
