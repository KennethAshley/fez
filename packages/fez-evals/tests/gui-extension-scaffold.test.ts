import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// The published scaffolder, built. `fez create` calls exactly this.
import { scaffold } from "../../../dist/scaffold.js";

/**
 * The whole "build on top" promise is that an OUTSIDER can scaffold a GUI
 * extension and have it load in the desktop. Nothing was proving that end
 * to end — the scaffolder could emit a bundle the host silently refuses,
 * and the first sign would be a panel that never appears in someone
 * else's app.
 *
 * So this drives the real path: `fez create --gui` → esbuild the IIFE →
 * load it exactly as packages/fez-desktop/src/gui-extensions.ts does
 * (`new Function(...) → __fezExt`) → run `activate(api)` against a faithful
 * mock of the GuiExtensionApi, gating each capability by the permission
 * the host actually checks. If the scaffolder under-declares a permission
 * (it did: registerGuiCommand needs `commands`, not `ui`), the command it
 * generates gets refused here — caught before it ships.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const WORK = path.join(REPO, "node_modules/.cache/fez-gui-scaffold");
const ESBUILD = path.join(REPO, "node_modules/.bin/esbuild");

afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

/** Load an IIFE bundle the way the desktop's importModule() fallback does. */
function loadIife(code: string): { default?: (api: unknown) => void; activate?: (api: unknown) => void } {
  const factory = new Function(
    "fetch",
    "WebSocket",
    "XMLHttpRequest",
    `${code}\n;return (typeof __fezExt !== "undefined" ? __fezExt : undefined);`
  );
  const deny = () => { throw new Error("blocked"); };
  return factory(deny, deny, deny);
}

describe("a scaffolded GUI extension loads and activates like the host runs it", () => {
  const dir = path.join(WORK, "probe-panel");
  fs.rmSync(WORK, { recursive: true, force: true });

  // 1) scaffold exactly what `fez create probe-panel --gui` writes
  const result = scaffold({ name: "probe-panel", dir, surfaces: ["gui"], apiVersion: "^0.1.0" });
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));

  it("declares the permissions the host gates its calls on", () => {
    // registerSettingsPanel → ui, registerGuiCommand → commands, client → read:channels.
    // Under-declaring any of these makes the host silently refuse the call.
    expect(pkg.fez.permissions).toEqual(expect.arrayContaining(["ui", "commands", "read:channels"]));
  });

  it("builds to an IIFE and registers a panel + command through the real gates", () => {
    // 2) esbuild the gui part exactly as the generated build script does
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    execFileSync(
      ESBUILD,
      [
        path.join(dir, "src/gui.tsx"),
        "--bundle",
        "--format=iife",
        "--global-name=__fezExt",
        "--platform=browser",
        "--jsx=transform",
        "--jsx-factory=h",
        `--outfile=${path.join(dir, "dist/gui.js")}`,
      ],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }
    );
    const code = fs.readFileSync(path.join(dir, "dist/gui.js"), "utf-8");

    // 3) a faithful mock of what the desktop hands `activate`, gated by the
    //    package's declared permissions (same shape as gui-extensions.ts).
    const granted: string[] = pkg.fez.permissions;
    const may = (p: string) => granted.includes(p);
    const created: unknown[] = [];
    let panelRender: (() => unknown) | undefined;
    let command: ((args: string) => unknown) | undefined;
    const refuse = (what: string) => () => { throw new Error(`refused: ${what}`); };
    const h = (type: unknown, props: unknown, ...kids: unknown[]) => {
      const el = { type, props, kids };
      created.push(el);
      return el;
    };
    const api = {
      React: { createElement: h, useState: (init: unknown) => [init, () => {}], useEffect: () => {}, useCallback: (f: unknown) => f },
      client: may("read:channels") ? { pubkey: "abcdef0123456789" } : undefined,
      openUrl: async () => {},
      registerSettingsPanel: may("ui")
        ? (_name: string, render: () => unknown) => { panelRender = render; }
        : refuse("settings panel"),
      registerGuiCommand: may("commands")
        ? (_name: string, run: (a: string) => unknown) => { command = run; }
        : refuse("gui command"),
    };

    // 4) load + activate exactly like the host
    const mod = loadIife(code);
    const activate = mod.default ?? mod.activate;
    expect(typeof activate).toBe("function");
    activate!(api);

    // the panel registered, and rendering it produces a React tree via our h
    expect(panelRender).toBeTypeOf("function");
    const before = created.length;
    const tree = panelRender!();
    expect(tree).toBeDefined();
    expect(created.length).toBeGreaterThan(before);

    // the command registered, and it round-trips its args (proving it was
    // NOT refused — the bug this catches)
    expect(command).toBeTypeOf("function");
    expect(String(command!("hello"))).toContain("hello");
  });
});
