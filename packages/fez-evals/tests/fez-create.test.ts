import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "../../../src/cli/scaffold.js";
import { packExtension } from "../../../src/cli/pack.js";
import { isGuiOnlyCreate } from "../../../src/cli/cmd-extensions.js";
import * as React from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { parseCustomGuiContributions } from "../../../src/extensions/gui-custom-contributions.js";
import { createCustomRuntime } from "../../fez-desktop/src/isolated-custom";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");

let dir: string;
beforeAll(async () => {
  // scaffold's 2nd arg is the EXACT output dir — same --dir semantics
  // `fez create` uses on every branch, not a parent to append the name to.
  dir = join(mkdtempSync(join(tmpdir(), "fez-create-")), "my-tool");
  await scaffold("my-tool", dir);
});
afterAll(() => rmSync(dirname(dir), { recursive: true, force: true }));

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

  it("packs and mounts its declared isolated navigation view with only UI permission", async () => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.fez.guiRuntime).toBe("isolated");
    expect(pkg.fez.permissions).toEqual(["ui"]);
    const [nav] = parseCustomGuiContributions(pkg.fez.guiContributions).nav;
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

    // Only IPC is replaced; the generated bundle and child mount adapter run.
    // Create the DOM after packing: esbuild needs Node's Uint8Array realm.
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    for (const key of ["window", "document", "Element", "HTMLElement"] as const) vi.stubGlobal(key, dom.window[key]);
    Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async () => ({
      surface: { kind: "nav", name: nav.name }, grants: pkg.fez.permissions,
      pubkey: "a".repeat(64), owner: "a".repeat(64), channels: [], workspaces: [],
      names: [], pubkeysByName: [], agents: null, reactions: [], receipts: [],
    }) } });
    const runtime = await createCustomRuntime({
      React, prefs: { get: async () => undefined, set: async () => {} },
      secrets: { has: async () => false, set: async () => {} },
      fetch: globalThis.fetch, openUrl: async () => {}, showDetails: async () => {},
      confirm: async () => false, registerSettingsPanel: () => {},
    }, { kind: "nav", name: nav.name });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      const extension = new Function(`${readFileSync(out.js, "utf8")}\nreturn __fezExt;`)() as {
        activate(api: Pick<typeof runtime.api, "registerNavView">): void;
      };
      extension.activate(runtime.api);
      root.render(React.createElement(runtime.View));
      await vi.waitFor(() => {
        expect(host.querySelector("h1")?.textContent).toBe("my-tool");
        expect(host.textContent).toContain("ready");
        expect(host.textContent).toContain("Nothing here yet.");
      });
    } finally {
      root.unmount();
      await Promise.resolve(); // the adapter disposes the extension's root in a microtask
      expect(host.textContent).toBe("");
      runtime.dispose();
      await new Promise(resolve => setImmediate(resolve)); // drain both React schedulers before removing window
      host.remove();
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });
});

describe("fez create — routing between the two scaffolders", () => {
  // Guards the riskiest part of Task 7's change: `create` reuses ONE
  // commander verb for both scaffolders (a second `.command("create")`
  // throws — commander refuses duplicate names). A future edit to the
  // routing condition could silently send the no-flag default (the old
  // multi-surface scaffolder's documented behavior) into the new
  // gui-only scaffold, or vice versa.
  it("bare `create <name>` (no flags) is NOT gui-only — stays on the old multi-surface scaffolder", () => {
    expect(isGuiOnlyCreate([])).toBe(false);
  });
  it("`--gui` alone IS gui-only — routes to the new @fezchat/ui scaffold", () => {
    expect(isGuiOnlyCreate(["gui"])).toBe(true);
  });
  it("`--headless --gui` together is NOT gui-only", () => {
    expect(isGuiOnlyCreate(["headless", "gui"])).toBe(false);
  });
  it("`--gui --relay` together is NOT gui-only", () => {
    expect(isGuiOnlyCreate(["gui", "relay"])).toBe(false);
  });
  it("`--relay` alone is NOT gui-only", () => {
    expect(isGuiOnlyCreate(["relay"])).toBe(false);
  });
});
