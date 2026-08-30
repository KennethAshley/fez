import { describe, it, expect } from "vitest";
import { checkText, imetaFor } from "../src/speak.js";

describe("checkText", () => {
  it("passes normal text", () => {
    expect(checkText("hello channel")).toBeUndefined();
  });
  it("rejects empty and whitespace", () => {
    expect(checkText("   ")).toMatch(/empty/i);
  });
  it("rejects over 2500 chars with a loud, actionable error", () => {
    const err = checkText("x".repeat(2501));
    expect(err).toMatch(/2500/);
    expect(err).toMatch(/shorten/i);
  });
  it("2500 exactly is allowed", () => {
    expect(checkText("x".repeat(2500))).toBeUndefined();
  });
});

describe("imetaFor", () => {
  it("matches the composer's NIP-92 shape", () => {
    expect(imetaFor("https://x/abc.mp3", 1234)).toEqual([
      "imeta",
      "url https://x/abc.mp3",
      "m audio/mpeg",
      "size 1234",
    ]);
  });
});
