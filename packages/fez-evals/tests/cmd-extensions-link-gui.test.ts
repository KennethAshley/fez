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
