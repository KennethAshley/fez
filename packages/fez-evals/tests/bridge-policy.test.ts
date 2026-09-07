import { describe, expect, test } from "vitest";
import { capReply, stripHarnessNoise } from "../../fez-acp/src/bridge-policy.js";

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

describe("stripHarnessNoise", () => {
  test("removes pi's npm update banner — meaningless for a bundled pi, never channel-worthy", () => {
    const banner = "New version available: v0.84.3 (installed v0.84.1). Run: `npm i -g @earendil-works/pi-coding-agent`";
    expect(stripHarnessNoise(`${banner}\nHey all — I'm @researcher.`)).toBe("Hey all — I'm @researcher.");
    // banner-only reply becomes empty — the empty-reply rejection then applies
    expect(stripHarnessNoise(banner)).toBe("");
    // normal text passes untouched
    expect(stripHarnessNoise("New version of my report is ready.")).toBe("New version of my report is ready.");
  });
});

describe("stripSelfAddress", () => {
  test("drops a leading self-mention, with or without @", async () => {
    const { stripSelfAddress } = await import("../../fez-acp/src/bridge-policy.js");
    expect(stripSelfAddress("@steph: Swish! What's up?", "steph")).toBe("Swish! What's up?");
    expect(stripSelfAddress("steph: on it", "steph")).toBe("on it");
  });
  test("keeps mid-sentence self-mentions and other names", async () => {
    const { stripSelfAddress } = await import("../../fez-acp/src/bridge-policy.js");
    expect(stripSelfAddress("ask @steph again later", "steph")).toBe("ask @steph again later");
    expect(stripSelfAddress("@quill: your turn", "steph")).toBe("@quill: your turn");
  });
});
