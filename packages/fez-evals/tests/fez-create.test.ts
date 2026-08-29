import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../../../src/cli/scaffold.js";
import { packExtension } from "../../../src/cli/pack.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");

let dir: string;
beforeAll(async () => { dir = await scaffold("my-tool", mkdtempSync(join(tmpdir(), "fez-create-"))); });

describe("fez create", () => {
  it("emits a package with a gui part, tsconfig, a TSX view and a README", () => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.fez.parts.gui).toBe("dist/view.js");
    expect(pkg.dependencies["@fezchat/ui"]).toBeTruthy();
    expect(pkg.devDependencies["@fezchat/tailwind-preset"]).toBeTruthy();
    expect(existsSync(join(dir, "src/view.tsx"))).toBe(true);
    expect(existsSync(join(dir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  it("the stub view is on-brand and guards its capabilities", () => {
    const view = readFileSync(join(dir, "src/view.tsx"), "utf8");
    expect(view).toContain("@fezchat/ui");     // built from the kit
    expect(view).toContain("createRoot");        // owns its React root
    expect(view).toMatch(/registerNavView/);     // mounts a place
    expect(view).toMatch(/api\.client\s*\?|if\s*\(!?\s*api\.client/); // guards, doesn't assert
    expect(view).not.toMatch(/#[0-9a-fA-F]{6}/);  // no bare hex — fez-* utilities only
  });

  it("the stub builds via fez pack", async () => {
    // esbuild bundle:true must RESOLVE @fezchat/ui/react/react-dom, which a
    // freshly-scaffolded package's isolated temp dir has no node_modules
    // for. Rather than a networked `bun install`, symlink the three deps
    // in from the worktree's already-built copies — the strongest check
    // that genuinely proves the stub bundles, not just that its syntax
    // parses.
    const nm = join(dir, "node_modules");
    mkdirSync(join(nm, "@fezchat"), { recursive: true });
    symlinkSync(join(REPO, "packages/fez-desktop/node_modules/react"), join(nm, "react"));
    symlinkSync(join(REPO, "packages/fez-desktop/node_modules/react-dom"), join(nm, "react-dom"));
    symlinkSync(join(REPO, "packages/fez-ui"), join(nm, "@fezchat/ui"));

    const out = await packExtension(dir);
    expect(existsSync(out.js)).toBe(true);
  });
});
