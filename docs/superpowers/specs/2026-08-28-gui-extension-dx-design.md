# GUI extension DX: VS Code-style loading, JSX + Tailwind authoring

**Status:** design, approved in conversation 2026-08-28. Not started.

Builds on `2026-08-27-extension-packages-design.md` (merged: one package
directory per install as source of truth). Companion to
`2026-08-28-extension-format-dx.md` (publishing/signing — sequenced after
this). This spec is the authoring and loading experience for GUI
extensions specifically.

## The question

"How do we make GUI extensions easy to write, and load them the way VS
Code / Obsidian load extensions?"

Two problems today, both DX:

1. **Loading is indirect.** The desktop scans `~/.fez/gui-extensions/`
   for symlinked `.js` files — a flat index left over from before the
   package-directory refactor. VS Code and Obsidian instead read the
   per-extension folder's manifest directly.
2. **Authoring is raw.** Extensions build UI with `api.React.createElement`
   / `h()` calls (no JSX), and style with inline styles only — which
   cannot express `:hover`, `:focus`, or media queries (the bazaar's
   buttons have no hover state for exactly this reason), against an
   undocumented "borrow App.css classes" contract that the reference
   extension itself shipped wrong.

## Prior art, and what fez is

fez's runtime is **Obsidian-shaped**, not VS Code-shaped:

| | VS Code | Obsidian | fez |
|---|---|---|---|
| Manifest | `package.json` | separate `manifest.json` | `package.json` `fez` block |
| Part code | compiled, `main` → entry | one bundled `main.js` | one bundled `gui.js` |
| Host API | `vscode` (injected, not bundled) | `obsidian` (injected) | `api` (injected) |
| UI rendering | **isolated webview** | **in-process into app DOM** | **in-process into host React** |
| Styling | webview's own CSS | **global `styles.css` + app CSS variables** | inline styles + theme tokens |

fez sits in Obsidian's column on every row that matters: in-process
rendering, an injected host module, one bundled part. The webview /
`.vsix` / isolation traits of VS Code were declined deliberately
(in-process was chosen over sandboxing). So Obsidian is the model to
follow, with one sensible VS Code borrow already in place: the manifest
lives in `package.json` (an extension is a normal npm package), which is
better for distribution.

The consequence that drives the styling design: Obsidian's answer to
"how do third-party plugins style themselves in one shared document" is
**the host loads the styling; plugins consume shared CSS variables and a
global stylesheet** — validated across thousands of plugins. That is the
design below, Tailwind-shaped.

## Scope

**In:** the desktop GUI surface only — how a `gui` part is loaded,
authored, and styled.

**Out, explicitly:**
- iOS / Android (real, but later — no design here).
- The TUI, CLI, relay, and sentinel loaders (they keep their current
  flat index; only the GUI surface converts).
- Isolation / webviews (declined; extensions stay in-process).
- Publishing, signing, `.fezx`, manifest derivation — that is
  `extension-format-dx`, sequenced after this. `fez pack` here is the
  build step only.

## Design

### 1. Loading — the VS Code / Obsidian flow

Today the desktop reads `~/.fez/gui-extensions/<name>.js` (a symlink into
the package dir). Instead the GUI loader **scans `~/.fez/packages/*/`,
reads each `package.json`, and loads the `gui` part directly from the
package folder** — download → extract to folder → read manifest →
activate, exactly the VS Code/Obsidian shape.

- `list_gui_extensions` (Rust, `lib.rs`) changes from "read the
  `gui-extensions` dir" to "for each `packages/<name>/`, read its
  manifest, and if `fez.parts.gui` is present, return the name plus the
  `gui` bundle read from `packages/<name>/<gui-rel-path>` (and its
  `styles` file if declared — see §4)."
- Install stops creating the `gui-extensions/<name>.js` symlink.
- Migration removes existing `gui-extensions/` symlinks — they become
  dead the moment the loader reads `packages/*/`. The loader change and
  the symlink removal ship in the same release, so there is never a
  window where the GUI can't find its extensions.
- **`bin/` symlinks stay** (that is how executables resolve on PATH —
  npm's `.bin` does the same). The other surfaces' index
  (`extensions/`, `relay-extensions/`, `workspace-providers/`) is
  untouched — those loaders are out of scope.

### 2. Separation stays in the manifest

The `gui` / `headless` / `relay` distinction the flat directories used to
carry moves entirely into the manifest's `fez.parts` keys — which is
exactly VS Code's `contributes`. `fez.parts.gui` says "this is a GUI
part"; the GUI loader reads that key and ignores the rest. The
separation is preserved conceptually; the physical `gui-extensions/`
directory is what goes away.

### 3. Authoring — JSX / TSX

Extensions author views in normal TSX, compiled against the **host's**
React — no bundled React, so bundles stay tiny and there is never a
second React fighting the host's hooks.

Mechanism (the automatic JSX runtime, pointed at an injected React):

- `@fezchat/extension-api` ships a `jsx-runtime` entry exporting `jsx`,
  `jsxs`, `Fragment` that delegate to the host's React
  `createElement` / `Fragment`. The host's React is not available when
  the shim's module evaluates (only at `activate(api)`), but `jsx()` is
  only *called* during render, which is after activation — so the shim
  resolves React lazily: the host publishes its React runtime on a
  known global before loading any extension, and the shim reads it
  inside `jsx`/`jsxs`.
- An extension's `tsconfig.json` sets
  `"jsxImportSource": "@fezchat/extension-api"`. The build emits
  `_jsx("div", …)` importing from the shim; the shim resolves to the
  host React at render time. The shim is ~15 lines and tiny to bundle;
  React is external.
- `h()` becomes an implementation detail an author never types.
- Classic-runtime fallback if the automatic runtime is fiddly under
  esbuild: `jsxFactory` pointed at the same injected-React global. Same
  result, uglier config.

`registerNavView` and the rest of the `api` surface do **not** change —
this is purely how the returned elements are authored.

### 4. Styling — a fez Tailwind preset wired to the theme tokens

Obsidian's model, Tailwind-shaped and **option A (host owns the
stylesheet)**:

- A **fez Tailwind preset** maps color utilities to the live theme
  tokens: `colors.fez.fg → var(--fg)`, `fez.surface → var(--bg1)`,
  `fez.elevated → var(--bg2)`, `fez.dim → var(--fg-dim)`,
  `fez.accent → var(--accent)`, `fez.brand → var(--brand)`, etc. So
  `bg-fez-surface`, `text-fez-fg`, `hover:bg-fez-elevated`, `md:flex`
  all work, and **theming is automatic** — every utility resolves to the
  live `var()`, so the frozen-gruvbox class of bug is structurally
  impossible.
- **The host ships one compiled fez utility stylesheet**, loaded once in
  the host document. It is Tailwind run over the preset with a generous
  safelist (layout, spacing, flex/grid, typography, the `fez-*` color
  utilities, the state variants `hover`/`focus`/`focus-within`/
  `disabled`, and the responsive breakpoints). Extensions **ship no CSS
  framework** — their JS references class-name strings that already
  exist in the document. Bundles stay JS-only; visual consistency is
  guaranteed; there is zero utility duplication across N extensions.
- **The preset is also published** (`@fezchat/tailwind-preset`) as a
  dev-only dependency, so an author gets Tailwind IntelliSense,
  autocomplete, and typo-checking against exactly the utilities the host
  provides — even though the runtime CSS comes from the host, not their
  bundle.
- **Escape hatch: CSS Modules.** Anything outside the shipped utility
  set is a `.module.css` the author writes. `fez pack` hashes the class
  names and emits a companion CSS file; the loader injects it as a
  `<style>` on activate and removes it on deactivate. Hashed names mean
  no collision with the host or other extensions, even though everything
  shares one document.
- **No Shadow DOM, no webview.** Style isolation was the only thing those
  would have added, and it is incoherent with an in-process host that
  already grants `api.client` directly — hardening the CSS boundary while
  the JS boundary is open. In-process + trusted + shared design system is
  the Obsidian posture, and it matches every other choice here.

Inline styles keep working, so existing extensions do not break; adopting
utilities/CSS-Modules is an opt-in upgrade.

### 5. Scaffold — `fez create`

One command emits a working GUI extension so the first five minutes need
no docs:

```
<name>/
  package.json          name, fez block (parts.gui: "dist/view.js"),
                        minFezVersion, a build script, the preset as a dev dep
  tsconfig.json         jsxImportSource: "@fezchat/extension-api"
  src/view.tsx          activate(api): registerNavView + a component that
                        USES the tokens (bg-fez-surface, text-fez-fg,
                        hover:) and the capability-guard pattern
                        (api.client absent-when-ungranted, degrade with a
                        message — never assume)
  src/styles.module.css optional starter CSS module
  README.md
```

The stub is where an author learns the two rules that are otherwise
learned by crashing: colors come from the `fez-*` utilities (never bare
hex), and `api.*` capabilities are absent-when-ungranted (guard, don't
assert).

`fez pack` (build only, in this spec): bundle `src/view.tsx` →
`dist/view.js` via esbuild (IIFE, JSX through the shim, React external),
process any CSS Module. Manifest derivation, hashing, and signing are
`extension-format-dx`, not here.

### 6. Migration

The gui-symlink removal is folded into the extension-packages migration
that already runs at startup: after a package dir exists for a name,
delete a now-dead `gui-extensions/<name>.js` symlink if present. Because
the new loader reads `packages/*/`, nothing needs the symlink after the
same release ships. Idempotent, and it touches only the `gui-extensions`
surface.

## Data flow

Install (unchanged from extension-packages, minus one symlink):
`package dir written → gui part sits at packages/<name>/dist/view.js`;
**no `gui-extensions` symlink is created.**

Load:
`list_gui_extensions scans packages/*/ → reads each manifest → for a
gui part, returns (name, bundle source, styles) → the desktop frontend
evaluates the IIFE and calls activate(api) → the extension's TSX renders
through the jsx-runtime shim into the host React tree → the host's fez
utility stylesheet + the theme tokens on :root style it → any CSS Module
is injected on activate.`

Theme change: the themes system rewrites the `--fg`/`--bg1`/… tokens on
`:root`; every `fez-*` utility resolves to the new value on the next
paint. Extensions do nothing.

## What deliberately does not change

- `registerNavView` and the rest of the `api` surface.
- In-process rendering into the host React tree (no isolation).
- One bundled part file per surface.
- The package directory as source of truth, and grants in `settings.json`.
- Every non-GUI loader, and the `bin/` symlinks.

## Non-goals

- Sandboxing / webviews / Shadow DOM.
- Mobile surfaces.
- Converting the TUI/CLI/relay/sentinel loaders (a later, separate pass —
  this proves the pattern on GUI first).
- Publishing/signing/`.fezx` (the format spec).
- Letting extensions add arbitrary global CSS (that is what the themes
  extension does through its own privileged path; a normal extension gets
  the utility layer + scoped CSS Modules, not the run of `:root`).

## Open questions

1. **jsx-runtime React handoff** — a global (`globalThis.__fezReact`) the
   host sets before loading extensions, vs. the loader passing React into
   each extension's IIFE scope. The global is simplest and the shim reads
   it lazily; the IIFE-scope form is cleaner but changes the load
   signature. Lean: global, since render is always post-activate.
2. **Safelist breadth for the shipped utility stylesheet** — too small
   frustrates authors, too large bloats the always-loaded CSS. Start from
   the utilities the existing four gui extensions actually use, plus the
   obvious layout/spacing/typography set, and grow it from real
   extensions.
3. **CSS Module injection lifetime** — inject-on-activate / remove-on-
   deactivate vs. inject-once-and-leave. Hashed names make leaving it
   harmless; removing it is tidier. Minor.
4. **Whether `fez create` is a new CLI verb or part of `fez pack`'s
   package** — naming only; decide when the CLI surface is touched.

## Done when

- The desktop GUI loads extensions by scanning `packages/*/` and reading
  each manifest's `gui` part; `gui-extensions/` symlinks are gone and the
  migration removes existing ones, with no window where the GUI loses its
  extensions.
- An author can write a GUI extension in TSX, style it with `fez-*`
  Tailwind utilities that follow the live theme, use a CSS Module for
  custom styling, and never type `h()` or a bare hex color.
- `fez create` emits a scaffold that builds and loads with the token
  utilities and the capability guard already in place.
- The four existing gui extensions (bazaar, wallet, loom, themes) still
  load and render (inline styles keep working); at least one is migrated
  to TSX + utilities as the reference.
- The pattern is proven on GUI and documented well enough that converting
  a second surface later is a mechanical follow-on.
