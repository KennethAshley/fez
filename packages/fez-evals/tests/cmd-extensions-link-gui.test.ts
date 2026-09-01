import { describe, expect, test, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { placeLinkedGuiPart } from "../../../src/cli/cmd-extensions.js";
import { fezHomeAt } from "../../../src/shared/fez-home.js";

/**
 * `fez link`'s gui-part placement used to copy the built bundle straight to
 * ~/.fez/gui-extensions/<name>.js. The desktop's loader stopped reading
 * that flat dir (it now reads packages/<name>/package.json +
 * fez.parts.gui, same as a real install) — so a linked extension's gui
 * part silently stopped loading. This pins that link produces the same
 * package-dir shape install does, and that the old flat file is NOT
 * created.
 */
describe("fez link — gui part lands in the package dir, not gui-extensions/", () => {
  let tmp: string;
  let base: string;
  let pkgDir: string;
  const name = "tidy";
  const manifest = {
    name: "@fezchat/tidy",
    version: "0.0.1",
    fez: { parts: { gui: "dist/gui.js" } },
  };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fez-link-gui-"));
    base = path.join(tmp, "home");
    pkgDir = path.join(tmp, "tidy");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "dist", "gui.js"), "export default () => {}; // v1\n");
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("writes packages/<name>/package.json + packages/<name>/<gui-rel>", () => {
    const dest = placeLinkedGuiPart(pkgDir, manifest, name, base);

    expect(dest).toBe(fezHomeAt(base, "packages", name, "dist", "gui.js"));
    expect(fs.readFileSync(dest, "utf-8")).toBe("export default () => {}; // v1\n");

    const manifestPath = fezHomeAt(base, "packages", name, "package.json");
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf-8"))).toEqual(manifest);
  });

  test("does NOT create the legacy gui-extensions/<name>.js flat file", () => {
    placeLinkedGuiPart(pkgDir, manifest, name, base);
    expect(fs.existsSync(fezHomeAt(base, "gui-extensions", `${name}.js`))).toBe(false);
  });

  test("refuses a gui rel that escapes the package dir with '..'", () => {
    const evilManifest = {
      name: "@fezchat/evil",
      version: "0.0.1",
      fez: { parts: { gui: "../../evil.js" } },
    };
    expect(() => placeLinkedGuiPart(pkgDir, evilManifest, "evil", base)).toThrow(/escapes/);
    expect(fs.existsSync(fezHomeAt(base, "packages", "evil"))).toBe(false);
  });

  test("refuses an absolute gui rel", () => {
    const evilManifest = {
      name: "@fezchat/evil2",
      version: "0.0.1",
      fez: { parts: { gui: "/etc/evil.js" } },
    };
    expect(() => placeLinkedGuiPart(pkgDir, evilManifest, "evil2", base)).toThrow(/escapes/);
    expect(fs.existsSync(fezHomeAt(base, "packages", "evil2"))).toBe(false);
  });
});

/**
 * The companion stylesheet travels with the gui part. `fez pack` emits a
 * hashed <stem>.css beside <stem>.js and the desktop loader reads that
 * sibling from the package dir — but NO installer copied it: ridges
 * installed from the gallery rendered its panel as bare markup, live.
 * Pinned here for link; the Rust tarball installer and PackageManager
 * carry the same fix (kept in step by contract, not by import).
 */
describe("fez link — the gui part's css sibling travels too", () => {
  test("gui.css beside gui.js lands in the package dir; absent css is not an error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fez-link-css-"));
    try {
      const base = path.join(tmp, "home");
      const pkgDir = path.join(tmp, "styled");
      fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "dist", "gui.js"), "export default () => {};\n");
      fs.writeFileSync(path.join(pkgDir, "dist", "gui.css"), ".fez-styled-abc123 { color: red; }\n");
      const manifest = { name: "@fezchat/styled", version: "0.0.1", fez: { parts: { gui: "dist/gui.js" } } };
      placeLinkedGuiPart(pkgDir, manifest, "styled", base);
      expect(fs.existsSync(fezHomeAt(base, "packages", "styled", "dist", "gui.css"))).toBe(true);

      // and a css-less package still links cleanly
      const bare = path.join(tmp, "bare");
      fs.mkdirSync(path.join(bare, "dist"), { recursive: true });
      fs.writeFileSync(path.join(bare, "dist", "gui.js"), "export default () => {};\n");
      placeLinkedGuiPart(bare, { name: "@fezchat/bare", version: "0.0.1", fez: { parts: { gui: "dist/gui.js" } } }, "bare", base);
      expect(fs.existsSync(fezHomeAt(base, "packages", "bare", "dist", "gui.js"))).toBe(true);
      expect(fs.existsSync(fezHomeAt(base, "packages", "bare", "dist", "gui.css"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
