import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packExtension } from "../../../src/cli/pack.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fez-pack-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "demo", fez: { parts: { gui: "dist/view.js" } },
  }));
  writeFileSync(join(dir, "src/view.tsx"),
    `import * as React from "react";
     export function activate(api:any){ api.registerNavView?.("demo",{glyph:"x",label:"Demo"},
       (host:HTMLElement)=>{ host.textContent = "ok"; return ()=>{}; }); }`);
});

describe("fez pack", () => {
  it("bundles src/view.tsx into an IIFE with activate on the global", async () => {
    const out = await packExtension(dir);
    expect(existsSync(out.js)).toBe(true);
    const js = readFileSync(out.js, "utf8");
    expect(js).toContain("__fezExt"); // --global-name
    expect(js).toContain("activate");
  });
});

describe("fez pack — CSS module", () => {
  let cssDir: string;
  beforeAll(() => {
    cssDir = mkdtempSync(join(tmpdir(), "fez-pack-css-"));
    mkdirSync(join(cssDir, "src"), { recursive: true });
    writeFileSync(join(cssDir, "package.json"), JSON.stringify({
      name: "demo-css", fez: { parts: { gui: "dist/view.js" } },
    }));
    writeFileSync(join(cssDir, "src/view.module.css"),
      `.title { color: red; }\n.btn { color: var(--fg); }\n.btn-primary { color: var(--brand); }\n`);
    writeFileSync(join(cssDir, "src/view.tsx"),
      `import * as React from "react";
       import styles from "./view.module.css";
       export function activate(api:any){ api.registerNavView?.("demo",{glyph:"x",label:"Demo"},
         (host:HTMLElement)=>{ host.className = styles.title + " " + styles.btn + " " + styles["btn-primary"]; return ()=>{}; }); }`);
  });

  it("hashes CSS module classes and writes dist/view.css", async () => {
    const out = await packExtension(cssDir);
    expect(out.css).toBeTruthy();
    expect(existsSync(out.css!)).toBe(true);
    const css = readFileSync(out.css!, "utf8");
    expect(css).toMatch(/\.fez-demo-css-[a-z0-9]+/);
    const js = readFileSync(out.js, "utf8");
    expect(js).toMatch(/fez-demo-css-[a-z0-9]+/);
  });

  it("gives prefix-related classes (btn / btn-primary) distinct, uncorrupted hashes", async () => {
    const out = await packExtension(cssDir);
    const css = readFileSync(out.css!, "utf8");
    // Match by the (untouched) declaration value rather than assuming
    // which selectors keep their original names — every class, including
    // "title", gets hashed.
    const btnMatch = css.match(/\.(fez-demo-css-[a-z0-9]+)\s*\{\s*color:\s*var\(--fg\)/);
    const btnPrimaryMatch = css.match(/\.(fez-demo-css-[a-z0-9]+)\s*\{\s*color:\s*var\(--brand\)/);
    expect(btnMatch).toBeTruthy();
    expect(btnPrimaryMatch).toBeTruthy();
    const btnHash = btnMatch![1];
    const btnPrimaryHash = btnPrimaryMatch![1];
    // distinct hashes
    expect(btnHash).not.toBe(btnPrimaryHash);
    // the btn-primary rule must not be a mangled "<btnHash>-primary" fragment
    expect(css).not.toContain(`.${btnHash}-primary`);
    // both hashed selectors must actually appear as their OWN rule (not just as a substring of one another)
    expect(css).toMatch(new RegExp(`\\.${btnHash}\\s*\\{`));
    expect(css).toMatch(new RegExp(`\\.${btnPrimaryHash}\\s*\\{`));
  });
});
