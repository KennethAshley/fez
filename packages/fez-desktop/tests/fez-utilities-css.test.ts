import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "../src/fez-utilities.css");

describe("host fez utility stylesheet", () => {
  beforeAll(() => {
    if (existsSync(cssPath)) rmSync(cssPath);
    execSync("bun run build:css", { cwd: join(here, ".."), stdio: "inherit" });
  });
  it("emits fez-* color utilities bound to theme vars", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(/\.bg-fez-surface\s*\{\s*background-color:\s*var\(--bg1\)/);
    expect(css).toMatch(/\.text-fez-fg\s*\{\s*color:\s*var\(--fg\)/);
  });
  it("emits a responsive variant so md:flex works", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(/@media[^{]*min-width[^{]*\)\s*\{[^}]*\.md\\:flex/s);
  });
});
