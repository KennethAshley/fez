/**
 * `fez pack` — bundle a gui extension's src/view.tsx into the single
 * IIFE the desktop loader evaluates (same flags every in-tree extension's
 * `build` script already invokes via the esbuild CLI: --bundle
 * --format=iife --global-name=__fezExt --platform=browser). This is the
 * JS-API equivalent, driven by the manifest's fez.parts.gui path instead
 * of a hardcoded outfile, plus CSS-Module class hashing.
 *
 * React ships bundled into the IIFE (no host-external) — see spec
 * ruling Q1. jsx: "automatic" needs no author-side build config.
 *
 * Scope note: this only EMITS a hashed dist/view.css companion when the
 * bundle imports a *.module.css. Nothing loads it yet — the Rust/loader
 * side that would inject it on mount is a separate, deferred plan.
 */
import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface PackManifest {
  name?: string;
  fez?: { parts?: { gui?: string } };
}

export interface PackResult {
  js: string;
  css?: string;
}

const CLASS_RE = /\.([A-Za-z_][A-Za-z0-9_-]*)/g;

/** fez-<pkgname>-<hash>: sanitize the pkg name (scoped names carry `@`/`/`) so it's a legal CSS identifier segment. */
function safePkgName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "ext";
}

function hashedClassName(pkgName: string, className: string): string {
  const hash = createHash("sha1").update(`${pkgName}:${className}`).digest("hex").slice(0, 8);
  return `fez-${pkgName}-${hash}`;
}

/**
 * esbuild plugin: intercept `*.module.css` imports, replace the module
 * with a JS map of {originalClass: hashedClass}, and stash the
 * class-rewritten CSS text for the caller to write to dist/view.css.
 *
 * ponytail: one CSS module per gui part — a simple selector-hash pass,
 * not a full CSS-Modules spec (no composes:, no scoping of anything but
 * class selectors). Upgrade if an extension needs more than one.
 */
function cssModulePlugin(pkgName: string): { plugin: Plugin; result: () => { hashedCss: string } | undefined } {
  let result: { file: string; hashedCss: string } | undefined;
  const plugin: Plugin = {
    name: "fez-css-modules",
    setup(b) {
      b.onLoad({ filter: /\.module\.css$/ }, (args) => {
        if (result && result.file !== args.path) {
          console.warn("ponytail: one CSS module per gui part; multi-module if an extension needs it");
          return { contents: "export default {};", loader: "js" };
        }
        const source = readFileSync(args.path, "utf8");
        const map: Record<string, string> = {};
        for (const m of source.matchAll(CLASS_RE)) {
          const cls = m[1];
          if (!(cls in map)) map[cls] = hashedClassName(pkgName, cls);
        }
        let hashedCss = source;
        // Longest-name-first: `\b` treats `-` as a non-word char, so a
        // shorter class replaced first (e.g. "btn") would also match
        // inside a longer, unrelated one ("btn-primary"), corrupting it.
        // Replacing longest-first consumes the longer name before the
        // shorter one's regex gets a chance at it.
        const byLengthDesc = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
        for (const [orig, hashed] of byLengthDesc) {
          hashedCss = hashedCss.replace(new RegExp(`\\.${orig}\\b`, "g"), `.${hashed}`);
        }
        result = { file: args.path, hashedCss };
        return { contents: `export default ${JSON.stringify(map)};`, loader: "js" };
      });
    },
  };
  return { plugin, result: () => result };
}

export async function packExtension(dir: string): Promise<PackResult> {
  const manifest: PackManifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const guiRel = manifest.fez?.parts?.gui;
  if (!guiRel) throw new Error(`${manifest.name ?? dir} declares no fez.parts.gui — nothing to pack`);

  const entry = path.join(dir, "src/view.tsx");
  if (!existsSync(entry)) throw new Error(`${manifest.name ?? dir} has no src/view.tsx`);

  const outfile = path.join(dir, guiRel);
  mkdirSync(path.dirname(outfile), { recursive: true });

  const pkgName = safePkgName(manifest.name ?? path.basename(dir));
  const { plugin, result } = cssModulePlugin(pkgName);

  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName: "__fezExt",
    platform: "browser",
    jsx: "automatic",
    outfile,
    plugins: [plugin],
  });

  const found = result();
  if (!found) return { js: outfile };

  // Name the companion CSS after the gui bundle itself (`<gui>.js` → `<gui>.css`),
  // NOT a hardcoded "view.css": the desktop loader (gui_parts) derives the CSS
  // path from the manifest's `fez.parts.gui` the same way, so an extension whose
  // gui part isn't `view.js` (e.g. loom's `gui.js`) still pairs correctly.
  const cssOut = outfile.replace(/\.js$/, ".css");
  writeFileSync(cssOut, found.hashedCss);
  return { js: outfile, css: cssOut };
}
