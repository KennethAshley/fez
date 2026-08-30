import { describe, it, expect } from "vitest";
import { PINNED, voiceFor } from "../src/voices.js";

describe("voiceFor", () => {
  const pk = "b7f0b1f5dc205d8c5ab07db0c7e61c20957d845c52bf21ee377469747430792f";

  it("is deterministic for a pk", () => {
    expect(voiceFor(pk)).toEqual(voiceFor(pk));
  });

  it("always lands inside the pinned list", () => {
    for (let i = 0; i < 64; i++) {
      const fake = i.toString(16).padStart(2, "0").repeat(32);
      expect(PINNED.some((v) => v.id === voiceFor(fake).id)).toBe(true);
    }
  });

  it("different pks spread across voices", () => {
    const picks = new Set(
      Array.from({ length: 40 }, (_, i) => voiceFor(i.toString(16).padStart(2, "0").repeat(32)).id)
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it("a prefs override wins, keyed by persona name", () => {
    const override = PINNED[PINNED.length - 1];
    expect(voiceFor(pk, { quill: override.id }, "quill").id).toBe(override.id);
  });

  it("an override naming an unknown voice id falls back to the deterministic pick", () => {
    expect(voiceFor(pk, { quill: "not-a-voice" }, "quill")).toEqual(voiceFor(pk));
  });
});
