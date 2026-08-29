import { describe, it, expect } from "vitest";
import fezPreset from "../src/index.js";

describe("fez tailwind preset", () => {
  it("maps every fez color utility to a live theme token, never a hex", () => {
    const colors = fezPreset.theme!.extend!.colors!.fez as Record<string, string>;
    expect(colors.surface).toBe("var(--bg1)");
    expect(colors.elevated).toBe("var(--bg2)");
    expect(colors.fg).toBe("var(--fg)");
    expect(colors.dim).toBe("var(--fg-dim)");
    expect(colors.accent).toBe("var(--accent)");
    expect(colors.brand).toBe("var(--brand)");
    expect(colors.green).toBe("var(--green)");
    // no raw hex anywhere — every value is a var() reference
    for (const v of Object.values(colors)) expect(v).toMatch(/^var\(--[a-z0-9-]+\)$/);
  });
});
