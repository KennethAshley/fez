import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PackageManager } from "../../../src/extensions/package-manager.js";
import { fezHomeAt } from "../../../src/shared/fez-home.js";

/**
 * The install/remove/update contract. `fez remove` used to clean only the
 * headless entry: removeParts() existed but was called from nowhere, so
 * gui/relay/workspace parts, bins, and the backgroundExtensions entry all
 * outlived the package — and the desktop's uninstall (which does clean
 * them) disagreed with the CLI. Install also never recorded declared
 * permissions, so a CLI-installed package silently ran on the legacy
 * grant while the same package linked with `fez link` got what it
 * declared. And `fez update` was advertised by install's own error
 * message without existing.
 */

function memSettings() {
  let state: Record<string, unknown> = {};
  return {
    load: () => state,
    save: (patch: Record<string, unknown>) => {
      state = { ...state, ...patch };
      return state;
    },
  };
}

const git = (cwd: string, cmd: string) =>
  execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, stdio: "pipe" });

let tmp: string;
let base: string; // fake home — ~/.fez lives under here
let pkgDir: string; // the local git repo we install from
let settings: ReturnType<typeof memSettings>;
let pm: PackageManager;

const at = (...segs: string[]) => fezHomeAt(base, ...segs);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fez-pkg-lifecycle-"));
  base = path.join(tmp, "home");
  pkgDir = path.join(tmp, "tidy");
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@fezchat/tidy",
      version: "0.0.1",
      private: true,
      type: "module",
      bin: { "tidy-tool": "dist/tool.js" },
      fez: {
        type: "extension",
        permissions: ["commands", "ui", "publish", "bogus:nonsense"],
        parts: {
          headless: "dist/headless.js",
          gui: "dist/gui.js",
          relay: "dist/relay.js",
          workspace: "dist/ws.js",
          background: true,
          skill: { command: "node", args: ["dist/mcp.js"] },
        },
      },
    })
  );
  for (const f of ["headless.js", "gui.js", "relay.js", "ws.js", "tool.js", "mcp.js"]) {
    fs.writeFileSync(path.join(pkgDir, "dist", f), `export default () => {}; // v1 ${f}\n`);
  }
  git(pkgDir, "init -q");
  git(pkgDir, "add -A");
  git(pkgDir, "commit -q -m v1");

  settings = memSettings();
  pm = new PackageManager({ base, settings });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("package lifecycle — install places, remove cleans, update refreshes", () => {
  test("install places every declared part under the injected home", async () => {
    await pm.init();
    await pm.install(`git:${pkgDir}`);

    expect(fs.existsSync(at("extensions", "tidy.js"))).toBe(true);
    expect(fs.existsSync(at("gui-extensions", "tidy.js"))).toBe(true);
    expect(fs.existsSync(at("relay-extensions", "tidy.js"))).toBe(true);
    expect(fs.existsSync(at("workspace-providers", "tidy.js"))).toBe(true);
    expect(fs.existsSync(at("bin", "tidy-tool"))).toBe(true);

    const s = settings.load() as {
      backgroundExtensions?: string[];
      mcpServers?: Record<string, unknown>;
    };
    expect(s.backgroundExtensions).toContain("tidy");
    expect(s.mcpServers?.tidy).toBeDefined();
  });

  test("install records the declared permission grant (parity with fez link)", () => {
    const s = settings.load() as { extensionPermissions?: Record<string, string[]> };
    // parsed, not verbatim: the unrecognized id grants nothing
    expect(s.extensionPermissions?.tidy).toEqual(["commands", "ui", "publish"]);
  });

  test("update refreshes the installed parts from the source", async () => {
    fs.writeFileSync(path.join(pkgDir, "dist", "headless.js"), `export default () => {}; // v2\n`);
    git(pkgDir, "add -A");
    git(pkgDir, "commit -q -m v2");

    await pm.update("tidy");

    expect(fs.readFileSync(at("extensions", "tidy.js"), "utf-8")).toContain("v2");
    expect(pm.get("tidy")).toBeDefined();
  });

  test("update on a package that isn't installed refuses loudly, not silently", async () => {
    await expect(pm.update("nope")).resolves.toBeUndefined(); // prints a warning, no throw
    expect(pm.get("nope")).toBeUndefined();
  });

  test("remove cleans every part, the bins, and the settings entries — but keeps the skill definition", async () => {
    await pm.remove("tidy");

    expect(fs.existsSync(at("extensions", "tidy.js"))).toBe(false);
    expect(fs.existsSync(at("gui-extensions", "tidy.js"))).toBe(false);
    expect(fs.existsSync(at("relay-extensions", "tidy.js"))).toBe(false);
    expect(fs.existsSync(at("workspace-providers", "tidy.js"))).toBe(false);
    expect(fs.existsSync(at("bin", "tidy-tool"))).toBe(false);

    const s = settings.load() as {
      backgroundExtensions?: string[];
      extensionPermissions?: Record<string, string[]>;
      mcpServers?: Record<string, unknown>;
    };
    expect(s.backgroundExtensions ?? []).not.toContain("tidy");
    expect(s.extensionPermissions?.tidy).toBeUndefined();
    // deliberate: the user may have filled env values, personas may declare it
    expect(s.mcpServers?.tidy).toBeDefined();
  });
});
