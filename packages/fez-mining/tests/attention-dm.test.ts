import { describe, it, expect } from "vitest";
import { attentionDmText, shouldDmAttention } from "../src/attention-dm.js";

describe("attentionDmText", () => {
  it("names the netuid and the reason", () => {
    const t = attentionDmText(56, "quill", "reprovision cap reached");
    expect(t).toContain("netuid 56");
    expect(t).toContain("reprovision cap reached");
  });
});

describe("shouldDmAttention", () => {
  it("fires on a new attention reason (no prior marker)", () => {
    expect(shouldDmAttention(undefined, "died")).toBe(true);
  });
  it("does not re-fire for the same reason", () => {
    expect(shouldDmAttention("died", "died")).toBe(false);
  });
  it("fires again when the reason changes", () => {
    expect(shouldDmAttention("died", "deregistered")).toBe(true);
  });
  it("treats a cleared marker ('') as no prior", () => {
    expect(shouldDmAttention("", "died")).toBe(true);
  });
});
