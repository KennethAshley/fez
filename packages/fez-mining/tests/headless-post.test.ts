import { describe, it, expect } from "vitest";
import { rootBackfillText } from "../src/headless.js";

describe("rootBackfillText", () => {
  it("is the miner root line for the persona", () => {
    expect(rootBackfillText(56, "quill")).toContain("netuid 56");
    expect(rootBackfillText(56, "quill")).toContain("quill");
  });
});
