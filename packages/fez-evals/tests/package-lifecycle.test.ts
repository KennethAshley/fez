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
      // "clix" -> "bin/index.js" mirrors the Rust fixture_tar exactly: a
      // bin source path that already lives under bin/ but under a
      // basename ("index.js") that differs from the command ("clix") —
      // the shape that used to make the CLI skip renaming to the command.
      bin: { "tidy-tool": "dist/tool.js", clix: "bin/index.js" },
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
  fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "bin", "index.js"), "#!/usr/bin/env node\n");
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

  // THE LAYOUT CONTRACT — must match the `mod tests` in
  // packages/fez-desktop/src-tauri/src/package_install.rs exactly.
  // packages/<base>/package.json         the manifest, as installed
  // packages/<base>/dist/<part>.js       real part files (gui/headless/relay/workspace)
  // packages/<base>/bin/<cmd>            real binaries (0755)
  // <flat dir>/<base>.js  -> symlink into packages/<base>/   (gui-extensions/extensions/relay-extensions/workspace-providers)
  // bin/<cmd>             -> symlink into packages/<base>/
  test("the golden layout — every line of the contract, against the tidy fixture", () => {
    const pkgRoot = at("packages", "tidy");

    const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8"));
    expect(manifest.name).toBe("@fezchat/tidy");

    for (const rel of ["dist/headless.js", "dist/gui.js", "dist/relay.js", "dist/ws.js"]) {
      expect(fs.existsSync(path.join(pkgRoot, rel)), rel).toBe(true);
    }

    // "clix" is declared as "bin/index.js" — a source path already under
    // bin/ with a basename that differs from the command. The canonical
    // copy must still land at packages/tidy/bin/clix, not bin/index.js.
    for (const cmd of ["tidy-tool", "clix"]) {
      const binPath = path.join(pkgRoot, "bin", cmd);
      expect(fs.existsSync(binPath), binPath).toBe(true);
      expect(fs.statSync(binPath).mode & 0o777, `packages/tidy/bin/${cmd} must be 0755`).toBe(0o755);
    }

    for (const [dir, file] of [
      ["extensions", "tidy.js"], ["gui-extensions", "tidy.js"],
      ["relay-extensions", "tidy.js"], ["workspace-providers", "tidy.js"],
      ["bin", "tidy-tool"], ["bin", "clix"],
    ] as const) {
      const p = at(dir, file);
      expect(fs.lstatSync(p).isSymbolicLink(), `${dir}/${file} must be a symlink`).toBe(true);
      expect(fs.realpathSync(p).startsWith(fs.realpathSync(pkgRoot)), `${dir}/${file} must resolve into packages/tidy`).toBe(true);
    }
  });

  test("install keeps the package: one dir with the manifest and the real files", () => {
    const pkgRoot = at("packages", "tidy");
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8"));
    expect(manifest.name).toBe("@fezchat/tidy");
    expect(manifest.version).toBe("0.0.1");
    // the real artifacts live IN the package dir
    for (const rel of ["dist/headless.js", "dist/gui.js", "dist/relay.js", "dist/ws.js", "bin/tidy-tool"]) {
      expect(fs.existsSync(path.join(pkgRoot, rel)), rel).toBe(true);
    }
  });

  test("the flat directories are an index pointing INTO the package dir", () => {
    for (const [dir, file] of [
      ["extensions", "tidy.js"], ["gui-extensions", "tidy.js"],
      ["relay-extensions", "tidy.js"], ["workspace-providers", "tidy.js"],
      ["bin", "tidy-tool"],
    ] as const) {
      const p = at(dir, file);
      const st = fs.lstatSync(p);
      expect(st.isSymbolicLink(), `${dir}/${file} must be a symlink`).toBe(true);
      expect(fs.realpathSync(p).includes(path.join("packages", "tidy")), `${dir}/${file} must resolve into packages/tidy`).toBe(true);
    }
  });

  test("the skill entry's relative args resolve into the installed package dir, not the source-fetch area", () => {
    // A package manifest says `args: ["dist/mcp.js"]` relative to ITSELF;
    // copied verbatim into settings it can never spawn (no cwd travels
    // with it — found live: fez-wallet's skill was uncallable by every
    // agent). Install must absolutize args that name package files —
    // and, like every other part, materialize the .js INTO packages/<base>/
    // rather than pointing at the source-fetch dir, so the CLI and the
    // Rust installer produce the identical mcpServers arg.
    const s = settings.load() as { mcpServers?: Record<string, { args?: string[] }> };
    const arg = s.mcpServers?.tidy?.args?.[0] ?? "";
    expect(path.isAbsolute(arg)).toBe(true);
    expect(fs.existsSync(arg)).toBe(true);
    expect(arg.endsWith(path.join("dist", "mcp.js"))).toBe(true);
    // The strengthened assertion: a future divergence (e.g. resolving
    // against the source-fetch dir again) must fail here even though the
    // weaker absolute+exists+endsWith checks above would still pass.
    expect(fs.realpathSync(arg).startsWith(fs.realpathSync(at("packages", "tidy")))).toBe(true);
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

describe("materializeIntoPackage refuses a traversal path", () => {
  test("a manifest part that escapes the package is refused, nothing written outside packages/<base>", async () => {
    const evilDir = path.join(tmp, "evil");
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, "package.json"), JSON.stringify({
      name: "@fezchat/evil", version: "0.0.1", private: true, type: "module",
      fez: { type: "extension", parts: { gui: "../evil.js" } },
    }));
    fs.writeFileSync(path.join(tmp, "evil.js"), "haha\n"); // outside evilDir, one level up
    git(evilDir, "init -q"); git(evilDir, "add -A"); git(evilDir, "commit -q -m v1");

    await expect(pm.install(`git:${evilDir}`)).rejects.toThrow(/escapes the package/);
    // nothing landed outside the package dir (mirrors the Rust traversal
    // test in package_install.rs, which makes the same assertion — a
    // manifest-write-before-parts phantom packages/evil/ dir is a
    // separate, deferred concern, not what this guard is about)
    expect(fs.existsSync(at("gui-extensions", "evil.js"))).toBe(false);
    expect(fs.existsSync(at("packages", "evil", "evil.js"))).toBe(false);
  });
});

describe("bin ownership — the flat namespace stops colliding silently", () => {
  test("a second package shipping the same command is refused, naming the owner", async () => {
    const clashDir = path.join(tmp, "clash");
    fs.mkdirSync(path.join(clashDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(clashDir, "package.json"), JSON.stringify({
      name: "@fezchat/clash", version: "0.0.1", private: true, type: "module",
      bin: { "tidy-tool": "dist/tool.js" }, fez: { type: "extension" },
    }));
    fs.writeFileSync(path.join(clashDir, "dist", "tool.js"), "export default 1;\n");
    git(clashDir, "init -q"); git(clashDir, "add -A"); git(clashDir, "commit -q -m v1");

    await pm.install(`git:${pkgDir}`); // tidy owns tidy-tool again
    await expect(pm.install(`git:${clashDir}`)).rejects.toThrow(/tidy-tool.*tidy/);
    // the loser must not have half-installed the bin
    expect(fs.realpathSync(at("bin", "tidy-tool")).includes(path.join("packages", "tidy"))).toBe(true);
    // ...nor left a phantom packages/clash/ behind (the manifest write now
    // happens AFTER the collision check, not before it)
    expect(fs.existsSync(at("packages", "clash"))).toBe(false);
  });

  test("removing one package never deletes a bin another still owns", async () => {
    // simulate a foreign owner: hand-plant a symlink into a different package dir
    const foreign = at("packages", "other", "bin");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "shared-cmd"), "x");
    fs.symlinkSync(path.join(foreign, "shared-cmd"), at("bin", "shared-cmd"));

    await pm.remove("tidy");
    expect(fs.existsSync(at("bin", "tidy-tool"))).toBe(false);       // its own: gone
    expect(fs.existsSync(at("bin", "shared-cmd"))).toBe(true);       // the other's: untouched
  });

  test("a collision refuses before any part install or settings write lands", async () => {
    await pm.install(`git:${pkgDir}`); // tidy owns tidy-tool again

    // A manifest that both wants a settings write (parts.background) AND
    // a headless part AND a colliding bin — the settings write and the
    // part file must never land ahead of the refusal.
    const clashBgDir = path.join(tmp, "clash-bg");
    fs.mkdirSync(path.join(clashBgDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(clashBgDir, "package.json"), JSON.stringify({
      name: "@fezchat/clash-bg", version: "0.0.1", private: true, type: "module",
      bin: { "tidy-tool": "dist/tool.js" },
      fez: { type: "extension", parts: { headless: "dist/headless.js", background: true } },
    }));
    fs.writeFileSync(path.join(clashBgDir, "dist", "tool.js"), "export default 1;\n");
    fs.writeFileSync(path.join(clashBgDir, "dist", "headless.js"), "export default () => {};\n");
    git(clashBgDir, "init -q"); git(clashBgDir, "add -A"); git(clashBgDir, "commit -q -m v1");

    await expect(pm.install(`git:${clashBgDir}`)).rejects.toThrow(/tidy-tool.*tidy/);

    const s = settings.load() as { backgroundExtensions?: string[] };
    expect(s.backgroundExtensions ?? []).not.toContain("clash-bg");
    expect(fs.existsSync(at("extensions", "clash-bg.js"))).toBe(false);
  });
});

describe("remove/update are driven by the package dir, not guesses", () => {
  test("remove is driven by the package dir and deletes it last", async () => {
    await pm.install(`git:${pkgDir}`);
    await pm.remove("tidy");
    expect(fs.existsSync(at("packages", "tidy"))).toBe(false);
    // and every index entry that resolved into it is gone
    for (const [dir, f] of [["extensions","tidy.js"],["gui-extensions","tidy.js"],["relay-extensions","tidy.js"],["workspace-providers","tidy.js"],["bin","tidy-tool"]] as const) {
      expect(fs.existsSync(at(dir, f)), `${dir}/${f}`).toBe(false);
    }
  });

  test("version comes from the package dir, not from settings", async () => {
    await pm.install(`git:${pkgDir}`);
    expect(pm.installedManifest("tidy")?.version).toBe("0.0.1");
    const s = settings.load() as Record<string, unknown>;
    expect(s.extensionVersions).toBeUndefined();
    expect(s.extensionBins).toBeUndefined();
  });
});
