# GUI Extension Authoring Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give GUI extension authors the "keep the look, one command to start" layer — a fez Tailwind preset wired to the live theme tokens, a shared `@fezchat/ui` component library that renders the app's own design grammar, and `fez create`/`fez pack` so a first extension needs no docs.

**Architecture:** Three related layers on top of the mount model that already shipped (Plan 1). (1) *Styling substrate:* a `@fezchat/tailwind-preset` maps `fez-*` color utilities to the theme's `var(--*)` tokens; the desktop host compiles one utility stylesheet from that preset and loads it once, so extensions ship JS-only and theme automatically; a CSS Module escape hatch is injected/removed by the loader. (2) *UI kit:* `@fezchat/ui` is the app's shell/form/identity primitives (`<Page>`, `<PageHeader>`, `<Field>`, `<Row active>`, `<Chip>`, `<EmptyState>`, `<Avatar>`) as React components rendering the *identical* App.css classes, so on-brand is the least code. (3) *Ergonomics:* `fez pack` bundles `src/view.tsx` → `dist/view.js` via esbuild (standard JSX, own React), and `fez create` scaffolds a working extension built from `@fezchat/ui`. One extension (loom) is migrated to the full pattern as the reference.

**Tech Stack:** TypeScript, React 19, esbuild (already the extension build tool), Tailwind CSS v3 (new dev dependency — preset + safelist model), Vitest (repo test runner), commander (CLI framework in `src/cli`), Tauri (desktop host).

**Spec:** `docs/superpowers/specs/2026-08-28-gui-extension-dx-design.md` — this plan implements §4 (Styling), §5 (Scaffold), §7 (UI kit), and the reference migration in §6/§7's "Done when". §1 (loading), §3 (mount model), and §6's symlink removal already shipped in Plan 1 and are NOT re-implemented here.

## Global Constraints

- **New npm packages use the `@fezchat` scope** (`@fez` is taken): `@fezchat/tailwind-preset`, `@fezchat/ui`. Match the existing `packages/fez-*` layout (see `packages/fez-client`, `packages/fez-extension-api`).
- **The Tailwind preset is a dev-only dependency for authors** — it exists so an author gets IntelliSense/typo-checking; the runtime CSS is shipped by the host, never by an extension bundle. Extensions ship **no CSS framework**.
- **Every color utility resolves to a live `var(--token)`** — never a frozen hex. `fez.surface → var(--bg1)`, `fez.elevated → var(--bg2)`, `fez.fg → var(--fg)`, `fez.dim → var(--fg-dim)`, `fez.accent → var(--accent)`, `fez.brand → var(--brand)`, `fez.mine → var(--bg-mine)`, `fez.rail → var(--bg-rail)`, `fez.green → var(--green)`, `fez.red → var(--red)`, `fez.yellow → var(--yellow)`, `fez.hairline → var(--hairline)`, `fez.field → var(--field)`. This makes the frozen-theme class of bug structurally impossible.
- **`@fezchat/ui` components render the EXACT App.css class names** the host already ships (`.fez-page`, `.page-head`, `.page-title`, `.page-sub`, `.page-rule`, `.page-fact`, `.page-empty`, `.settings-field`, `.settings-hint`, `.avatar`, etc.). Correctness of the kit = the rendered DOM is byte-identical to what `App.tsx` renders. It does **not** depend on the Tailwind preset (it uses existing classes, present in the host document).
- **No Shadow DOM, no webview, no JSX shim.** In-process, light-DOM, standard JSX. The mount model (`mount(host) => Dispose`) already shipped — this plan builds on it, it does not change it.
- **Author-facing rules baked into the scaffold:** colors come from `fez-*` utilities (never bare hex); `api.*` capabilities are absent-when-ungranted (guard, don't assert).
- **TDD throughout.** Watch each test fail before implementing. Commit after each green step. Every package's `build` and the repo `vitest run` must stay green.
- **Do not touch** non-GUI loaders, `bin/` symlinks, the package-dir-as-source-of-truth contract, or `activate(api)` as the entry.

---

## File Structure

New package `packages/fez-tailwind-preset/`:
- `package.json` — `@fezchat/tailwind-preset`, `main: dist/index.js`, `types: dist/index.d.ts`, a `build` (tsc), `tailwindcss` as a peer dep.
- `src/index.ts` — the preset object: the `fez.*` color map to `var(--*)`, exported as a Tailwind `Config`-shaped partial (`{ theme: { extend: { colors: { fez: {...} } } } }`).
- `tests/preset.test.ts`

New package `packages/fez-ui/`:
- `package.json` — `@fezchat/ui`, `main/types`, `react` as a peer dep, a `build` (tsc).
- `src/index.ts` — barrel re-export.
- `src/shell.tsx` — `<Page>`, `<PageHeader>`, `<EmptyState>`.
- `src/form.tsx` — `<Field>`, `<Row>`, `<Chip>`.
- `src/identity.tsx` — `<Avatar>` + the moved sprite core.
- `src/sprites.ts`, `src/sprite-gen.ts`, `src/pixel-sprite.tsx` — MOVED from `packages/fez-desktop/src/`.
- `tests/shell.test.tsx`, `tests/form.test.tsx`, `tests/identity.test.tsx`

Desktop host (`packages/fez-desktop/`):
- `tailwind.config.cjs` — CREATE: `presets: [require('@fezchat/tailwind-preset')]`, `safelist`, `content: []` (safelist-driven, extensions aren't scanned).
- `src/fez-utilities.css` — CREATE (generated, git-ignored): Tailwind output; built by a new `build:css` script wired into `dev`/`build`.
- `src/App.tsx` — MODIFY: `import "./fez-utilities.css"` next to `import "./App.css"`.
- `src/gui-extensions.ts` — MODIFY: inject a gui part's companion CSS (`styles`) as a `<style>` on activate/mount, remove on dispose.
- `src/identity.ts` — MODIFY (and consumers): re-export Avatar/sprite from `@fezchat/ui`; delete the moved files.

CLI (`src/cli/`):
- `cmd-extensions.ts` — MODIFY: register `fez pack` and `fez create` verbs.
- `pack.ts` — CREATE: the esbuild bundle + CSS-Module processing used by `fez pack` (and by `fez create`'s generated `build` script indirectly).
- `scaffold.ts` — CREATE: the `fez create` file emitter + the template strings.

Migration reference:
- `packages/fez-loom/src/gui.ts` → `packages/fez-loom/src/gui.tsx` — MODIFY: rewrite to `mount(host)` + `createRoot` + `@fezchat/ui` + `fez-*` utilities; update `packages/fez-loom/package.json` build to `fez pack` / esbuild TSX.

Tests live beside each package under its `tests/` dir, run by the repo's root `vitest`.

---

## Task 1: `@fezchat/tailwind-preset` package

**Files:**
- Create: `packages/fez-tailwind-preset/package.json`
- Create: `packages/fez-tailwind-preset/src/index.ts`
- Create: `packages/fez-tailwind-preset/tsconfig.json`
- Test: `packages/fez-tailwind-preset/tests/preset.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: default export `fezPreset` — a Tailwind config partial: `{ theme: { extend: { colors: { fez: Record<string,string> } } } }` where each value is a `var(--token)` string. Task 2 loads it via `presets: [require('@fezchat/tailwind-preset')]`. Task 7's scaffold lists it as a dev dep.

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-tailwind-preset/tests/preset.test.ts
import { describe, it, expect } from "vitest";
import fezPreset from "../src/index.js";

describe("fez tailwind preset", () => {
  it("maps every fez color utility to a live theme token, never a hex", () => {
    const colors = fezPreset.theme!.extend!.colors!.fez as Record<string, string>;
    expect(colors.surface).toBe("var(--bg1)");
    expect(colors.elevated).toBe("var(--bg2)");
    expect(colors.fg).toBe("var(--fg)");
    expect(colors.dim).toBe("var(--fg-dim)");
    expect(colors.accent).toBe("var(--accent)");
    expect(colors.brand).toBe("var(--brand)");
    expect(colors.green).toBe("var(--green)");
    // no raw hex anywhere — every value is a var() reference
    for (const v of Object.values(colors)) expect(v).toMatch(/^var\(--[a-z0-9-]+\)$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/fez-tailwind-preset/tests/preset.test.ts`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Write `package.json` and `tsconfig.json`**

```jsonc
// packages/fez-tailwind-preset/package.json
{
  "name": "@fezchat/tailwind-preset",
  "version": "0.1.0",
  "description": "A Tailwind preset whose fez-* color utilities resolve to the live fez theme tokens. Dev-only for extension authors: IntelliSense + typo-checking against the utilities the fez host ships at runtime.",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "peerDependencies": { "tailwindcss": "^3" },
  "devDependencies": { "tailwindcss": "^3", "typescript": "^5" }
}
```

```jsonc
// packages/fez-tailwind-preset/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "declaration": true, "outDir": "dist", "strict": true, "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `src/index.ts` (minimal)**

```ts
// packages/fez-tailwind-preset/src/index.ts
import type { Config } from "tailwindcss";

/**
 * Every fez-* color utility resolves to a live theme token, so a class
 * name written by an extension follows the user's theme with no plumbing:
 * `bg-fez-surface` is `background-color: var(--bg1)`, and when the themes
 * system rewrites --bg1 on :root the utility repaints. This is why the
 * frozen-gruvbox class of bug is structurally impossible.
 */
const fez = {
  fg: "var(--fg)",
  dim: "var(--fg-dim)",
  surface: "var(--bg1)",
  elevated: "var(--bg2)",
  base: "var(--bg0)",
  mine: "var(--bg-mine)",
  rail: "var(--bg-rail)",
  accent: "var(--accent)",
  brand: "var(--brand)",
  green: "var(--green)",
  red: "var(--red)",
  yellow: "var(--yellow)",
  hairline: "var(--hairline)",
  field: "var(--field)",
} as const;

const preset: Partial<Config> = {
  theme: { extend: { colors: { fez } } },
};

export default preset;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run packages/fez-tailwind-preset/tests/preset.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the package builds**

Run: `cd packages/fez-tailwind-preset && bun install && bunx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/fez-tailwind-preset
git commit -m "@fezchat/tailwind-preset: fez-* color utilities resolve to live theme tokens"
```

---

## Task 2: Host compiles and loads one fez utility stylesheet

**Files:**
- Create: `packages/fez-desktop/tailwind.config.cjs`
- Modify: `packages/fez-desktop/package.json` (add `tailwindcss` + `@fezchat/tailwind-preset` dev deps; add a `build:css` script; chain it into `dev` and the release `build`)
- Modify: `packages/fez-desktop/src/App.tsx` (import the generated stylesheet)
- Modify: `packages/fez-desktop/.gitignore` (or the repo root) to ignore `src/fez-utilities.css`
- Test: `packages/fez-desktop/tests/fez-utilities-css.test.ts`

**Interfaces:**
- Consumes: `fezPreset` from Task 1.
- Produces: a generated `packages/fez-desktop/src/fez-utilities.css` containing the safelisted utilities; loaded once in the host document so any `fez-*` class an extension references already exists.

**Ruling (spec open question 2 — safelist breadth):** start from what the existing gui extensions actually use plus the obvious set: layout (`flex`, `grid`, `block`, `hidden`, `items-*`, `justify-*`, `gap-*`), spacing (`p-*`, `px-*`, `py-*`, `m-*`, `mt-*`, `gap-*` for the common 0–6 scale), sizing (`w-full`, `h-full`, `max-w-*`), typography (`text-sm`/`base`/`lg`, `font-medium`/`semibold`/`mono`, `truncate`), borders/radius (`rounded`, `rounded-md`, `border`, `border-fez-hairline`), the `fez-*` color utilities for `bg`/`text`/`border`, the state variants `hover`/`focus`/`focus-within`/`disabled`, and the responsive breakpoints `sm`/`md`/`lg`. Grow from real extensions later. Use Tailwind v3's `safelist` with pattern entries.

**Ruling (Tailwind version):** Tailwind v3. Its `presets`/`safelist`/`content` model is exactly what the spec describes; v4's CSS-first `@theme` model dropped `safelist` and would not match the preset design.

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-desktop/tests/fez-utilities-css.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/fez-desktop/tests/fez-utilities-css.test.ts`
Expected: FAIL — no `build:css` script / no config.

- [ ] **Step 3: Add dev deps and scripts to `packages/fez-desktop/package.json`**

Add to `devDependencies`: `"tailwindcss": "^3"`, `"@fezchat/tailwind-preset": "workspace:*"` (or the repo's local-link convention — match how `@fezchat/client` is referenced in this package). Add scripts:

```jsonc
"build:css": "tailwindcss -c tailwind.config.cjs -o src/fez-utilities.css --minify"
```

Chain `build:css` before the existing `dev` and the Vite/Tauri `build` (prepend `bun run build:css && ` to those scripts so the stylesheet is always fresh).

- [ ] **Step 4: Create `packages/fez-desktop/tailwind.config.cjs`**

```js
// packages/fez-desktop/tailwind.config.cjs
// Safelist-driven: extensions are NOT scanned (their class strings live in
// bundles we don't compile here). We emit a generous fixed utility set the
// host document carries once, so any fez-* class an extension references
// already exists. Grow the safelist from real extensions (spec Q2).
const preset = require("@fezchat/tailwind-preset").default ?? require("@fezchat/tailwind-preset");

const FEZ_COLORS = ["fg","dim","surface","elevated","base","mine","rail","accent","brand","green","red","yellow","hairline","field"];
const COLOR_PROPS = ["bg","text","border"];

module.exports = {
  presets: [preset],
  content: [],
  corePlugins: { preflight: false }, // the host owns base styles (App.css)
  safelist: [
    "flex","grid","block","inline-block","hidden","flex-col","flex-row","flex-1","flex-wrap",
    "items-center","items-start","items-end","justify-center","justify-between","justify-start","justify-end",
    "w-full","h-full","max-w-full","min-w-0","overflow-auto","overflow-hidden","truncate","relative","absolute",
    "rounded","rounded-md","rounded-lg","border","font-mono","font-medium","font-semibold",
    "text-xs","text-sm","text-base","text-lg",
    { pattern: /^(gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-(0|1|2|3|4|5|6|8)$/ },
    { pattern: new RegExp(`^(${COLOR_PROPS.join("|")})-fez-(${FEZ_COLORS.join("|")})$`),
      variants: ["hover","focus","focus-within","disabled"] },
    { pattern: /^(flex|grid|hidden|items-center|justify-between)$/, variants: ["sm","md","lg"] },
  ],
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run packages/fez-desktop/tests/fez-utilities-css.test.ts`
Expected: PASS. If the responsive assertion is brittle against minified output, drop `--minify` in the test's build invocation or assert on the un-minified marker; keep `--minify` for the real build script.

- [ ] **Step 6: Load the stylesheet in the host document**

In `packages/fez-desktop/src/App.tsx`, beside the existing `import "./App.css";`, add:

```ts
import "./fez-utilities.css";
```

- [ ] **Step 7: Git-ignore the generated file**

Add `packages/fez-desktop/src/fez-utilities.css` to the nearest `.gitignore`. Confirm `git status` does not list it.

- [ ] **Step 8: Verify the desktop still typechecks and the app dev-builds the CSS**

Run: `cd packages/fez-desktop && bun run build:css && bunx tsc --noEmit`
Expected: CSS emitted, tsc exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/fez-desktop/tailwind.config.cjs packages/fez-desktop/package.json packages/fez-desktop/src/App.tsx packages/fez-desktop/tests/fez-utilities-css.test.ts .gitignore
git commit -m "desktop: compile and load one fez utility stylesheet from the preset"
```

---

## Task 3: The loader injects and removes a gui part's companion CSS

**Files:**
- Modify: `packages/fez-desktop/src/gui-extensions.ts` (inject a `styles` string as a `<style>` on activate/mount; remove it on dispose)
- Test: `packages/fez-desktop/tests/gui-css-injection.test.ts`

**Interfaces:**
- Consumes: the loader's per-extension record gains an optional `styles?: string` (the compiled CSS Module output; Task 6's `fez pack` produces `dist/view.css`, and the Rust scan returns it — that scan change rides along here as the record shape). For this task, drive it from the loader function directly.
- Produces: `injectExtensionStyles(name: string, css: string): () => void` — appends a `<style data-fez-ext="<name>">` to `document.head`, returns a disposer that removes exactly that node. Idempotent: calling inject twice for one name replaces, not duplicates.

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-desktop/tests/gui-css-injection.test.ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { injectExtensionStyles } from "../src/gui-extensions.js";

afterEach(() => { document.head.querySelectorAll("style[data-fez-ext]").forEach((n) => n.remove()); });

describe("gui extension css injection", () => {
  it("injects a scoped style node and removes it on dispose", () => {
    const dispose = injectExtensionStyles("loom", ".loom-x{color:red}");
    const node = document.head.querySelector('style[data-fez-ext="loom"]');
    expect(node?.textContent).toContain(".loom-x");
    dispose();
    expect(document.head.querySelector('style[data-fez-ext="loom"]')).toBeNull();
  });
  it("replaces rather than duplicates for the same extension", () => {
    injectExtensionStyles("loom", ".a{}");
    injectExtensionStyles("loom", ".b{}");
    const nodes = document.head.querySelectorAll('style[data-fez-ext="loom"]');
    expect(nodes.length).toBe(1);
    expect(nodes[0].textContent).toContain(".b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/fez-desktop/tests/gui-css-injection.test.ts`
Expected: FAIL — `injectExtensionStyles` not exported.

- [ ] **Step 3: Implement `injectExtensionStyles` in `gui-extensions.ts`**

```ts
/**
 * A gui part's companion CSS (a hashed CSS Module `fez pack` emitted) is
 * injected once, keyed by extension name, and removed on dispose. Hashed
 * class names mean it cannot collide with the host or another extension,
 * so this is a plain document-level <style> — no Shadow DOM needed.
 */
export function injectExtensionStyles(name: string, css: string): () => void {
  const sel = `style[data-fez-ext="${CSS.escape(name)}"]`;
  document.head.querySelector(sel)?.remove(); // replace, don't stack
  const el = document.createElement("style");
  el.setAttribute("data-fez-ext", name);
  el.textContent = css;
  document.head.appendChild(el);
  return () => el.remove();
}
```

- [ ] **Step 4: Wire it into activation**

At the point where a gui part is activated (near the `activate(api)` call around `gui-extensions.ts:943`), if the extension record carries a non-empty `styles`, call `injectExtensionStyles(name, styles)` and store the returned disposer alongside the extension's other teardown, so uninstall/deactivate removes the CSS with everything else. Keep it a no-op when `styles` is absent.

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run packages/fez-desktop/tests/gui-css-injection.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify desktop typechecks**

Run: `cd packages/fez-desktop && bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/fez-desktop/src/gui-extensions.ts packages/fez-desktop/tests/gui-css-injection.test.ts
git commit -m "desktop: gui loader injects and disposes an extension's companion CSS"
```

---

## Task 4: `@fezchat/ui` — shell and form primitives

**Files:**
- Create: `packages/fez-ui/package.json`
- Create: `packages/fez-ui/tsconfig.json`
- Create: `packages/fez-ui/src/shell.tsx` (`<Page>`, `<PageHeader>`, `<EmptyState>`)
- Create: `packages/fez-ui/src/form.tsx` (`<Field>`, `<Row>`, `<Chip>`)
- Create: `packages/fez-ui/src/index.ts` (barrel)
- Test: `packages/fez-ui/tests/shell.test.tsx`, `packages/fez-ui/tests/form.test.tsx`

**Interfaces:**
- Consumes: nothing at runtime beyond `react` (peer). Relies on the host document already carrying `App.css` (the classes these components emit).
- Produces:
  - `Page({ wide?: boolean, children })` → `<main className="main"><div className={"fez-page"+(wide?" wide":"")}>…</div></main>` (the exact wrapper `AgentsPage.tsx:95` uses so a view fills rail→pane).
  - `PageHeader({ title, subtitle?, fact?, action? })` → `.page-head` > `.page-title` + `.page-sub` + `.page-rule` (with `.page-fact`/`.page-fact-action`). Carries the rule.
  - `EmptyState({ line, how? })` → `.page-empty` > `.page-empty-line` + `.page-empty-how` (full-voice, not a grey italic line).
  - `Field({ label, hint?, children })` → `.settings-field` with `.settings-hint`.
  - `Row({ active?, onClick?, children })` → a row whose active state draws the ember notch (square-cornered pixel on the left edge; muted rows, lit chosen one). Emit the same class the app uses for an active row — verify the exact class in `App.css`/`SkillsView.tsx` during implementation and match it (do not invent a new class name).
  - `Chip({ children, tone? })` → `.skill-chip`/`.pill`.

- [ ] **Step 1: Write the failing tests**

```tsx
// packages/fez-ui/tests/shell.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Page, PageHeader, EmptyState } from "../src/index.js";

describe("shell primitives render the app's own classes", () => {
  it("PageHeader carries title, subtitle and the rule", () => {
    const { container } = render(<PageHeader title="agents" subtitle="one line" fact="3 agents" />);
    expect(container.querySelector(".page-head .page-title")?.textContent).toBe("agents");
    expect(container.querySelector(".page-sub")?.textContent).toBe("one line");
    expect(container.querySelector(".page-rule .page-fact")?.textContent).toContain("3 agents");
  });
  it("Page fills to the pane via the main wrapper", () => {
    const { container } = render(<Page wide><span>x</span></Page>);
    expect(container.querySelector("main.main .fez-page.wide")).toBeTruthy();
  });
  it("EmptyState speaks in two lines", () => {
    const { container } = render(<EmptyState line="No agents yet." how="Make one." />);
    expect(container.querySelector(".page-empty .page-empty-line")?.textContent).toBe("No agents yet.");
    expect(container.querySelector(".page-empty-how")?.textContent).toBe("Make one.");
  });
});
```

```tsx
// packages/fez-ui/tests/form.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Field, Row, Chip } from "../src/index.js";

describe("form primitives", () => {
  it("Field wraps a labelled control with a hint", () => {
    const { container, getByText } = render(<Field label="Relay" hint="wss://"><input /></Field>);
    expect(container.querySelector(".settings-field")).toBeTruthy();
    expect(getByText("wss://").className).toContain("settings-hint");
    expect(container.querySelector(".settings-field input")).toBeTruthy();
  });
  it("Row marks the active one for the ember notch", () => {
    const { container } = render(<><Row>a</Row><Row active>b</Row></>);
    const rows = container.querySelectorAll("[data-active]");
    // the active row carries the app's active-row class (matched from App.css)
    expect(container.textContent).toContain("b");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
  it("Chip renders the app's chip class", () => {
    const { container } = render(<Chip>rust</Chip>);
    expect(container.querySelector(".skill-chip, .pill")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run packages/fez-ui/tests/`
Expected: FAIL — package not resolvable. (If `@testing-library/react` is not yet a repo dev dep, add it; check whether another package already uses it first and reuse that version.)

- [ ] **Step 3: Write `package.json` and `tsconfig.json`**

```jsonc
// packages/fez-ui/package.json
{
  "name": "@fezchat/ui",
  "version": "0.1.0",
  "description": "The fez app's own shell/form/identity primitives as React components — an extension built from them renders the identical DOM and follows every theme for free.",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "peerDependencies": { "react": ">=18" },
  "devDependencies": { "react": "^19", "@types/react": "^19", "typescript": "^5" }
}
```

`tsconfig.json`: same shape as Task 1's plus `"jsx": "react-jsx"`, `"lib": ["ES2022","DOM"]`.

- [ ] **Step 4: Implement `src/shell.tsx`, `src/form.tsx`, `src/index.ts`**

Before writing, open `packages/fez-desktop/src/AgentsPage.tsx` (the `Page`/`PageHeader`/`EmptyState` markup) and `packages/fez-desktop/src/SkillsView.tsx` + `App.css` (the active-row class and `.settings-field`/`.skill-chip` markup). Emit those exact class names and structure. Example `shell.tsx`:

```tsx
import * as React from "react";

export function Page({ wide, children }: { wide?: boolean; children: React.ReactNode }) {
  return <main className="main"><div className={"fez-page" + (wide ? " wide" : "")}>{children}</div></main>;
}

export function PageHeader(
  { title, subtitle, fact, action }:
  { title: string; subtitle?: string; fact?: string; action?: { label: string; onClick: () => void } }
) {
  return (
    <header className="page-head">
      <h1 className="page-title">{title}</h1>
      {subtitle && <p className="page-sub">{subtitle}</p>}
      {(fact || action) && (
        <div className="page-rule">
          {action && <button className="page-fact page-fact-action" onClick={action.onClick}>{action.label}</button>}
          {fact && <span className="page-fact">{fact}</span>}
        </div>
      )}
    </header>
  );
}

export function EmptyState({ line, how }: { line: string; how?: string }) {
  return (
    <div className="page-empty">
      <div className="page-empty-line">{line}</div>
      {how && <div className="page-empty-how">{how}</div>}
    </div>
  );
}
```

Implement `form.tsx` (`Field`, `Row`, `Chip`) against the real classes; `Row` sets the active-row class + `data-active` so the ember notch (a `::before` pixel in App.css) renders. `index.ts` re-exports everything from both files.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run packages/fez-ui/tests/`
Expected: PASS. Adjust the `Row` assertion to the real class you matched from `App.css`.

- [ ] **Step 6: Verify the package builds**

Run: `cd packages/fez-ui && bun install && bunx tsc -p tsconfig.json`
Expected: `dist/` emitted, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/fez-ui
git commit -m "@fezchat/ui: shell and form primitives rendering the app's own classes"
```

---

## Task 5: `@fezchat/ui` — identity primitives (move the sprite core)

**Files:**
- Create: `packages/fez-ui/src/identity.tsx` (`<Avatar>`)
- Move: `packages/fez-desktop/src/sprites.ts`, `sprite-gen.ts`, `pixel-sprite.tsx` → `packages/fez-ui/src/` (single source of truth)
- Modify: `packages/fez-desktop/src/Avatar.tsx` and every desktop importer of the moved files → import from `@fezchat/ui`
- Modify: `packages/fez-ui/src/index.ts` (export `Avatar`, `generateSprite`, `Sprite`, `PixelSprite`)
- Test: `packages/fez-ui/tests/identity.test.tsx`

**Interfaces:**
- Consumes: `react` (peer).
- Produces: `Avatar({ pk, name?, size? })` → renders the pubkey-generated sprite (`.avatar`); `generateSprite(pk)`, `type Sprite`, `PixelSprite` re-exported for the desktop and future consumers.

**Scope ruling:** the web copy of the sprite files (per the Qud-identity note, sprites are duplicated across web + desktop) is **out of scope** for this task — this move unifies desktop + `@fezchat/ui` only; a later pass can point the web build at `@fezchat/ui`. Note this in the ledger so it isn't mistaken for done.

**Boundary:** `quips.ts` (hover quips) stays in the desktop — it is app-chrome, not an identity primitive. If `Avatar.tsx` couples the quip to the sprite, keep the quip wiring in the desktop's thin `Avatar` wrapper and export only the sprite-rendering `<Avatar>` from the kit.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/fez-ui/tests/identity.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Avatar, generateSprite } from "../src/index.js";

const PK = "npub1exampleexampleexampleexampleexampleexampleexampleex";

describe("identity primitives", () => {
  it("generates a deterministic sprite for a pubkey", () => {
    expect(generateSprite(PK)).toEqual(generateSprite(PK));
  });
  it("Avatar renders the .avatar element for a pk", () => {
    const { container } = render(<Avatar pk={PK} />);
    expect(container.querySelector(".avatar")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/fez-ui/tests/identity.test.tsx`
Expected: FAIL — no identity exports.

- [ ] **Step 3: Move the sprite core into `@fezchat/ui`**

`git mv packages/fez-desktop/src/sprites.ts packages/fez-desktop/src/sprite-gen.ts packages/fez-desktop/src/pixel-sprite.tsx packages/fez-ui/src/`. Fix relative imports inside the moved files. Note `pixel-sprite.tsx` currently imports `App.css` (Task 2 grep) — drop that import from the moved file; the host document supplies `App.css`, and a shared package must not import an app stylesheet.

- [ ] **Step 4: Write `identity.tsx` and export**

Port the sprite-rendering portion of the desktop `Avatar.tsx` into `packages/fez-ui/src/identity.tsx` as `<Avatar pk name? size?>`, using the moved `generateSprite`/`PixelSprite`. Export `Avatar`, `generateSprite`, `Sprite`, `PixelSprite` from `index.ts`.

- [ ] **Step 5: Repoint the desktop**

Rewrite `packages/fez-desktop/src/Avatar.tsx` to import `Avatar`/`generateSprite`/sprite types from `@fezchat/ui` (keeping the desktop's quip wiring as a thin wrapper if present). Update every other desktop import of `./sprites`, `./sprite-gen`, `./pixel-sprite` to `@fezchat/ui`. Find them: `grep -rl "from \"\./\(sprites\|sprite-gen\|pixel-sprite\)\"" packages/fez-desktop/src`.

- [ ] **Step 6: Run tests + desktop typecheck**

Run: `bunx vitest run packages/fez-ui/tests/ && cd packages/fez-desktop && bunx tsc --noEmit`
Expected: kit tests PASS; desktop tsc exit 0 (all sprite imports resolve to `@fezchat/ui`).

- [ ] **Step 7: Guard against a stale duplicate**

Run: `test ! -f packages/fez-desktop/src/sprites.ts && echo MOVED` — confirm the desktop copies are gone (moved, not copied), so there is one source of truth.

- [ ] **Step 8: Commit**

```bash
git add -A packages/fez-ui packages/fez-desktop/src
git commit -m "@fezchat/ui: move the pubkey-sprite Avatar into the shared kit; desktop imports it"
```

---

## Task 6: `fez pack` — build a gui extension bundle

**Files:**
- Create: `src/cli/pack.ts` (the bundler)
- Modify: `src/cli/cmd-extensions.ts` (register the `pack` verb)
- Test: `packages/fez-evals/tests/fez-pack.test.ts` (or the repo's CLI test location — match where `cmd-extensions` is already tested)

**Interfaces:**
- Consumes: an extension package dir with `src/view.tsx` and a `package.json` naming `fez.parts.gui` = `dist/view.js`.
- Produces: `packExtension(dir: string): Promise<{ js: string; css?: string }>` — esbuild-bundles `src/view.tsx` → `dist/view.js` (IIFE, `--global-name=__fezExt`, `platform=browser`, standard JSX via esbuild's `jsx: automatic`, the extension's own React bundled), and if a referenced `*.module.css` exists, hashes its class names and writes `dist/view.css`, returning both paths. `fez pack` calls this on the cwd package.

**Ruling (spec Q3 — CSS Module lifetime):** inject-on-mount / remove-on-dispose (Task 3 already does this); `fez pack` just emits the hashed CSS + a JS map the bundle imports. **Ruling (spec Q4 — verb naming):** `fez pack` is its own verb (not folded into another).

**Ruling (spec Q1 — React):** bring-your-own React, bundled into the IIFE. No host external in this plan.

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-evals/tests/fez-pack.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/fez-evals/tests/fez-pack.test.ts`
Expected: FAIL — `../../../src/cli/pack.js` not found.

- [ ] **Step 3: Implement `src/cli/pack.ts`**

Use the esbuild JS API (already a dependency — the existing package `build` scripts call the esbuild CLI). Mirror the flags the in-tree extensions use (`--bundle --format=iife --global-name=__fezExt --platform=browser --outfile=dist/gui.js`) but read the outfile from `package.json`'s `fez.parts.gui`, set `jsx: "automatic"`, and add CSS-Module handling: if `src` imports a `*.module.css`, hash each class to `fez-<name>-<hash>`, rewrite the imported map, and write `dist/view.css`. Keep the CSS-Module path minimal — a single module file per extension is enough for v1; log if more are found (`ponytail: one CSS module per gui part; multi-module if an extension needs it`).

- [ ] **Step 4: Register the verb in `cmd-extensions.ts`**

```ts
program
  .command("pack")
  .description("Build this GUI extension: src/view.tsx → dist/view.js (and a hashed CSS module if present)")
  .action(async () => {
    const { packExtension } = await import("./pack.js");
    const out = await packExtension(process.cwd());
    console.log(`packed ${out.js}${out.css ? ` + ${out.css}` : ""}`);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run packages/fez-evals/tests/fez-pack.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/pack.ts src/cli/cmd-extensions.ts packages/fez-evals/tests/fez-pack.test.ts
git commit -m "fez pack: bundle a gui extension's src/view.tsx via esbuild, hash its CSS module"
```

---

## Task 7: `fez create` — scaffold a working extension

**Files:**
- Create: `src/cli/scaffold.ts` (the file emitter + templates)
- Modify: `src/cli/cmd-extensions.ts` (register the `create` verb)
- Test: `packages/fez-evals/tests/fez-create.test.ts`

**Interfaces:**
- Consumes: `packExtension` from Task 6 (the generated `build` script runs `fez pack`).
- Produces: `scaffold(name: string, targetDir: string): Promise<string>` — writes the tree from spec §5 and returns the created dir. `fez create <name>` calls it in cwd.

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-evals/tests/fez-create.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "../../../src/cli/scaffold.js";
import { packExtension } from "../../../src/cli/pack.js";

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
    const out = await packExtension(dir);
    expect(existsSync(out.js)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/fez-evals/tests/fez-create.test.ts`
Expected: FAIL — no `scaffold.js`.

- [ ] **Step 3: Implement `src/cli/scaffold.ts`**

Emit the tree from spec §5. The `src/view.tsx` template (exact, no placeholders):

```tsx
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Page, PageHeader, EmptyState } from "@fezchat/ui";
import type { GuiExtensionApi } from "@fezchat/extension-api/gui";

function App({ api }: { api: GuiExtensionApi }) {
  // api.client is absent when the read:channels grant was declined — guard,
  // never assert. Colors come from fez-* utilities, never a bare hex.
  if (!api.client) {
    return <Page><PageHeader title="__NAME__" subtitle="Grant channel access to see your data." /></Page>;
  }
  return (
    <Page wide>
      <PageHeader title="__NAME__" subtitle="Your extension, built from @fezchat/ui." fact="ready" />
      <div className="bg-fez-surface text-fez-fg rounded-md p-4">
        <EmptyState line="Nothing here yet." how="Edit src/view.tsx to build your view." />
      </div>
    </Page>
  );
}

export function activate(api: GuiExtensionApi) {
  api.registerNavView("__NAME__", { glyph: "◆", label: "__NAME__" }, (host) => {
    const root = createRoot(host!);
    root.render(<App api={api} />);
    return () => root.unmount(); // the mount model's disposer
  });
}
```

Substitute `__NAME__` with the given name. `package.json` template: `type: module`, `fez: { parts: { gui: "dist/view.js" }, minFezVersion: <current> }`, `dependencies`: `react`, `react-dom`, `@fezchat/ui`; `devDependencies`: `@fezchat/tailwind-preset`, `@fezchat/extension-api`, `esbuild`, `typescript`, `@types/react`; `scripts.build`: `"fez pack"`. `tsconfig.json`: standard `react-jsx`. `src/styles.module.css`: a one-line starter comment. `README.md`: the two rules (fez-* utilities, capability guards) + `fez pack` to build.

- [ ] **Step 4: Register the verb**

```ts
program
  .command("create")
  .description("Scaffold a new GUI extension built from @fezchat/ui")
  .argument("<name>", "extension name (a new directory under the cwd)")
  .action(async (name) => {
    const { scaffold } = await import("./scaffold.js");
    const dir = await scaffold(name, process.cwd());
    console.log(`created ${dir} — cd in, bun install, then fez pack`);
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run packages/fez-evals/tests/fez-create.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/scaffold.ts src/cli/cmd-extensions.ts packages/fez-evals/tests/fez-create.test.ts
git commit -m "fez create: scaffold an on-brand GUI extension built from @fezchat/ui"
```

---

## Task 8: Migrate loom to the full pattern (the reference)

**Files:**
- Rename+rewrite: `packages/fez-loom/src/gui.ts` → `packages/fez-loom/src/gui.tsx`
- Modify: `packages/fez-loom/package.json` (build via TSX/`fez pack`-style esbuild with `jsx: automatic`; add `react`, `react-dom`, `@fezchat/ui`, `@fezchat/extension-api` deps)
- Test: `packages/fez-loom/tests/gui-smoke.test.tsx` (or extend loom's existing tests if present)

**Interfaces:**
- Consumes: `@fezchat/ui`, the mount model (already shipped), `fez-*` utilities (Task 2).
- Produces: loom's gui part still registering its nav view ("tools gallery") and rendering, now via `mount(host)` + `createRoot` + `@fezchat/ui` instead of `h()` calls.

- [ ] **Step 1: Write the failing/again-green smoke test**

```tsx
// packages/fez-loom/tests/gui-smoke.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { activate } from "../src/gui.js"; // built output resolves to gui.tsx after rename

describe("loom gui migrated to the mount model", () => {
  it("registers a nav view whose mount renders into the host and returns a disposer", () => {
    const registerNavView = vi.fn();
    activate({ registerNavView, React } as any);
    expect(registerNavView).toHaveBeenCalled();
    const mount = registerNavView.mock.calls[0][2];
    const host = document.createElement("div");
    const dispose = mount(host);
    expect(host.childNodes.length).toBeGreaterThan(0);
    expect(typeof dispose).toBe("function");
    dispose();
  });
});
import * as React from "react";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/fez-loom/tests/gui-smoke.test.tsx`
Expected: FAIL — current `gui.ts` returns an element from `h()`, not a `mount(host)` disposer.

- [ ] **Step 3: Rewrite loom's gui to the full pattern**

Rename to `gui.tsx`. Replace the `h()` tree with a React component built from `@fezchat/ui` (`<Page>` + `<PageHeader>` for the tools gallery header, `fez-*` utilities for the grid), and register it via `mount(host) => { const root = createRoot(host); root.render(<Gallery .../>); return () => root.unmount(); }`. Preserve loom's actual behavior (the tools gallery, push-delta subscribe) — this is a presentation migration, not a feature change.

- [ ] **Step 4: Update loom's build**

In `packages/fez-loom/package.json`, change the `build` to bundle `src/gui.tsx` with `jsx: automatic` and React bundled (mirror Task 6's flags, or set `build` to `fez pack` if loom adopts the `src/view.tsx` convention — keep loom's existing `dist/gui.js` output path so the manifest stays valid). Add the new deps.

- [ ] **Step 5: Run test + build to verify green**

Run: `bunx vitest run packages/fez-loom/tests/gui-smoke.test.tsx && cd packages/fez-loom && bun install && bun run build`
Expected: test PASS, build emits `dist/gui.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-loom
git commit -m "loom: migrate the gui to the mount model + @fezchat/ui (the reference)"
```

---

## Task 9: Author documentation

**Files:**
- Create: `docs/extensions/gui-authoring.md` (or the repo's docs convention — check `packages/fez-docs` and existing `docs/` layout first and match it)
- Modify: the scaffold's generated `README.md` (Task 7) is the per-extension doc; this is the one-page overview.

**Interfaces:** none (docs).

- [ ] **Step 1: Write the doc**

One page: `fez create <name>` → `bun install` → edit `src/view.tsx` → `fez pack` → `fez link` (dev loop). The two rules (fez-* utilities never bare hex; guard capabilities). The mount model in three sentences. A `@fezchat/ui` component table (`<Page>`, `<PageHeader>`, `<Field>`, `<Row active>`, `<Chip>`, `<EmptyState>`, `<Avatar>`). The CSS Module escape hatch. Link the spec.

- [ ] **Step 2: Verify links resolve and the commands match the shipped verbs**

Run: `grep -o "fez [a-z]*" docs/extensions/gui-authoring.md | sort -u` and confirm each verb exists in `cmd-extensions.ts`.

- [ ] **Step 3: Commit**

```bash
git add docs/extensions/gui-authoring.md
git commit -m "docs: authoring a GUI extension (create → pack → link, the kit, the two rules)"
```

---

## Self-Review

**1. Spec coverage:**
- §4 Styling: preset (Task 1), host stylesheet (Task 2), CSS Module injection (Task 3), CSS Module emission (Task 6). ✓ Escape-hatch "bring your own CSS" is inherent (an author can inject in `mount`) — no task needed.
- §5 Scaffold: `fez pack` (Task 6), `fez create` (Task 7). ✓
- §7 UI kit: shell/form (Task 4), identity/Avatar (Task 5). ✓ Idioms (ember notch, empty-room voice, identity-gets-a-face) are baked into Tasks 4–5.
- §6 Migration: the gui-symlink removal already shipped in Plan 1; the reference migration is Task 8. ✓
- "Done when" bullets: loading (Plan 1) ✓; author writes standard React + fez-* + CSS Module, never `h()`/hex/fez build config (Tasks 6–7) ✓; `fez create` on-brand output (Task 7) ✓; `@fezchat/ui` primitives + idioms in one library (Tasks 4–5) ✓; one extension migrated to the full pattern (Task 8) ✓; documented (Task 9) ✓.

**2. Placeholder scan:** No "TBD"/"handle edge cases". The only intentional `__NAME__` tokens are template substitution markers with explicit substitution instruction. Task 4/8 ask the implementer to *match an existing class from App.css* rather than invent one — that is a real instruction (read the source), not a placeholder.

**3. Type consistency:** `packExtension(dir) → { js: string; css?: string }` used identically in Tasks 6, 7. `scaffold(name, dir) → string` consistent in Task 7. `injectExtensionStyles(name, css) → () => void` consistent in Task 3. `Page`/`PageHeader`/`EmptyState`/`Field`/`Row`/`Chip`/`Avatar` names consistent across Tasks 4, 5, 7, 8. The gui part entry is `dist/view.js` for new extensions (Tasks 6–7) but loom keeps `dist/gui.js` (Task 8) — intentional and called out, since loom's manifest already points there.

**Open rulings recorded (from spec §Open questions):** Tailwind v3 (Task 2); safelist seed set (Task 2); CSS Module lifetime = inject-on-mount/remove-on-dispose (Tasks 3, 6); `fez pack`/`fez create` as their own verbs (Tasks 6, 7); bring-your-own React bundled (Task 6); web sprite copy out of scope (Task 5).
