import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every design token the CSS reads must exist in every theme.
 *
 * This gate is written from a real failure. App.css grew a SECOND token
 * block during the sidebar redesign — --bg-rail, --hairline, --phosphor
 * — and the theme packs only knew about the first. Switching to a light
 * theme therefore left the sidebar hard-coded near-black while --fg went
 * near-black too: an invisible sidebar, and no error anywhere.
 *
 * A missing token is not a crash, it is a silent inheritance of whatever
 * the stylesheet happened to hard-code. That is exactly the class of bug
 * a type system cannot see and a screenshot catches — so it gets a test.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(here, "../../fez-desktop/src/App.css");
const css = fs.readFileSync(cssPath, "utf8");

/** Tokens DEFINED in a :root block — the contract a theme must satisfy. */
function declaredTokens(source: string): Set<string> {
  const tokens = new Set<string>();
  for (const block of source.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const decl of block[1].matchAll(/(--[a-z0-9-]+)\s*:/g)) tokens.add(decl[1]);
  }
  return tokens;
}

const required = declaredTokens(css);

/** Call a theme pack's activate() with a stub and capture what it registers. */
async function packFrom(modulePath: string): Promise<Record<string, Record<string, string>>> {
  const mod = await import(modulePath);
  let captured: Record<string, Record<string, string>> = {};
  (mod.default as (api: { registerTheme(n: string, v: unknown): void }) => void)({
    registerTheme: (_name, vars) => {
      captured = vars as Record<string, Record<string, string>>;
    },
  });
  return captured;
}

describe("the CSS declares tokens; themes must supply them", () => {
  it("finds the token contract in App.css", () => {
    // Sanity: if the parse breaks, every assertion below passes vacuously.
    expect(required.size).toBeGreaterThan(10);
    expect(required).toContain("--bg-rail");
    expect(required).toContain("--phosphor");
  });

  it("the built-in default covers every token, light and dark", async () => {
    const { BUILT_IN_DEFAULT } = await import("../../fez-desktop/src/gui-extensions.js");
    for (const scheme of ["dark", "light"] as const) {
      const missing = [...required].filter((t) => !(t in (BUILT_IN_DEFAULT as never)[scheme]));
      expect(missing, `default/${scheme} is missing ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("the fez theme covers every token, light and dark", async () => {
    const pack = await packFrom("../../fez-theme-fez/src/gui.js");
    for (const scheme of ["dark", "light"] as const) {
      const missing = [...required].filter((t) => !(t in pack[scheme]));
      expect(missing, `fez/${scheme} is missing ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("a light palette is actually lighter than its dark twin", async () => {
    // Guards the inverted-by-accident case: a 'light' variant whose
    // ground is dark is worse than no light variant at all.
    const luminance = (hex: string): number => {
      const n = parseInt(hex.replace("#", ""), 16);
      return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
    };
    const { BUILT_IN_DEFAULT } = await import("../../fez-desktop/src/gui-extensions.js");
    const fez = await packFrom("../../fez-theme-fez/src/gui.js");
    for (const [name, pack] of [["default", BUILT_IN_DEFAULT], ["fez", fez]] as const) {
      for (const token of ["--bg0", "--bg1", "--bg-rail"]) {
        const light = luminance((pack as never)["light"][token]);
        const dark = luminance((pack as never)["dark"][token]);
        expect(light, `${name} ${token}: light must be lighter than dark`).toBeGreaterThan(dark);
      }
      // …and the text must invert with it, or you get the invisible
      // sidebar this whole test exists because of.
      expect(luminance((pack as never)["light"]["--fg"])).toBeLessThan(
        luminance((pack as never)["dark"]["--fg"])
      );
    }
  });
});
