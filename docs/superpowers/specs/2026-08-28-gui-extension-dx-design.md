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
| UI rendering | **isolated webview** | **host gives a DOM node; plugin owns its framework** | **host gives a DOM node; extension owns its framework** (this spec) |
| Styling | webview's own CSS | **global `styles.css` + app CSS variables** | host utility stylesheet + theme tokens |

fez sits in Obsidian's column on every row that matters: in-process
(not sandboxed), an injected host module, one bundled part, and — with
this spec's pivot — the same rendering contract: **the host hands the
extension a DOM element and the extension mounts whatever it wants into
it.** The webview / `.vsix` / isolation traits of VS Code were declined
deliberately. So Obsidian is the model to follow, with one sensible VS
Code borrow already in place: the manifest lives in `package.json` (an
extension is a normal npm package), which is better for distribution.

The previous fez rendering model — extensions returned React elements
that the host rendered *into its own React tree* — is what this spec
changes. That inline model forced a single shared React and awkward
machinery to route the extension's JSX into the host's React instance.
Obsidian's node-handoff model has no such constraint: simpler to
implement, and more familiar to write against (a standard React app),
so this spec adopts it (§3).

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

### 3. Authoring — the mount model (own framework, standard JSX)

The host hands the extension a DOM element; the extension mounts its own
UI into it. This is Obsidian's contract, and it makes an extension a
**completely standard React app** — no shared React, no shim, no
fez-specific build config.

The API shifts from "return elements the host renders" to "mount into
this node." A view registration's third argument changes shape:

```ts
// before — the host renders the returned elements in its own tree:
registerNavView(name, opts, render: () => El): void

// after — the host gives a container; the extension mounts and returns a disposer:
type Dispose = () => void;
registerNavView(name, opts, mount: (host: HTMLElement) => Dispose | void): void
```

The extension's default export is still `activate(api)`; inside it,
`mount` is where the extension owns everything:

```tsx
// standard React, standard JSX, standard tooling — nothing fez-specific
import { createRoot } from "react-dom/client";
export default function activate(api) {
  api.registerNavView("Bazaar", { glyph: "◈", label: "Bazaar" }, (host) => {
    const root = createRoot(host);
    root.render(<BazaarView api={api} />);
    return () => root.unmount();   // host calls this on hide/uninstall
  });
}
```

What this buys, and why it's the pivot:

- **No shared React, no shim, no `jsxImportSource` config.** The
  extension bundles its own React (or Preact, or Svelte, or nothing —
  its choice) and renders into the host's node. There is no single-React
  constraint because the host's React and the extension's React never
  touch. An author writes exactly the React app they'd write anywhere.
- **`api` arrives as an argument** (`activate(api)`, passed into the
  component as a prop) — not a global, not a side channel.
- **Independent roots = contained failure.** Each view is its own React
  root on its own node; an extension that throws during render corrupts
  only its own subtree, not the host's tree. The old inline model could
  take the host's render down with it.
- **Bundle cost is the extension's call.** Its own React is ~40KB
  gzipped; Preact is ~4KB; vanilla is nothing. Views mount lazily (only
  when shown), so an installed-but-unopened extension costs nothing at
  boot. The host MAY additionally expose React as a build-time external
  for size-conscious authors who opt in (§ open questions) — but the
  default is bring-your-own, which is what keeps the tooling standard.

The registration surfaces that return UI (`registerNavView`,
`registerThreadView`, `registerSettingsPanel`, `registerPageView`,
`registerBlockRenderer`, `registerArtifactAction`) all move from
`() => El` to `(host: HTMLElement) => Dispose | void`. `activate(api)`
and the non-UI surface of `api` are unchanged.

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
  already grants `api.client` directly. In-process + trusted + shared
  design system is the Obsidian posture, and it matches every other
  choice here. Because the extension mounts into a plain host node in the
  same light DOM, the theme tokens on `:root` and the host utility
  stylesheet both apply to it with no plumbing — inherited custom
  properties reach any descendant, and a global stylesheet is global.
- **An extension may still ship its own CSS.** Since the mount model
  makes each extension self-contained, an author who wants styling beyond
  the shared utilities writes a CSS Module (default) or bundles their own
  stylesheet and injects it in `mount`. The host layer is the shared
  default, not a cage.

Inline styles keep working, so existing extensions do not break; adopting
utilities/CSS-Modules is an opt-in upgrade.

### 5. Scaffold — `fez create`

One command emits a working GUI extension so the first five minutes need
no docs:

```
<name>/
  package.json          name, fez block (parts.gui: "dist/view.js"),
                        minFezVersion, a build script; react + react-dom
                        as normal deps; the preset as a dev dep
  tsconfig.json         standard React JSX — nothing fez-specific
  src/view.tsx          activate(api): registerNavView with a mount(host)
                        callback that createRoot()s a component; the
                        component USES the tokens (bg-fez-surface,
                        text-fez-fg, hover:) and the capability-guard
                        pattern (api.client absent-when-ungranted,
                        degrade with a message — never assume)
  src/styles.module.css optional starter CSS module
  README.md
```

The stub is where an author learns the two rules otherwise learned by
crashing: colors come from the `fez-*` utilities (never bare hex), and
`api.*` capabilities are absent-when-ungranted (guard, don't assert). It
is otherwise an ordinary React app — `import React`, standard JSX,
standard build — which is the whole point.

`fez pack` (build only, in this spec): bundle `src/view.tsx` →
`dist/view.js` via esbuild (IIFE, standard JSX, the extension's own React
bundled — or external if the author opts in), process any CSS Module.
Manifest derivation, hashing, and signing are `extension-format-dx`, not
here.

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
`list_gui_extensions scans packages/*/ → reads each manifest → for a gui
part, returns (name, bundle source, styles) → the desktop frontend
evaluates the IIFE and calls activate(api) → when a view is shown the
host creates a container node and calls the extension's mount(host) → the
extension mounts its OWN React root into that node and returns a disposer
→ the host's fez utility stylesheet + the theme tokens on :root style it
(same light DOM) → any CSS Module is injected on mount → on hide/uninstall
the host calls the disposer, which unmounts the extension's root.`

Theme change: the themes system rewrites the `--fg`/`--bg1`/… tokens on
`:root`; every `fez-*` utility resolves to the new value on the next
paint. Extensions do nothing.

## What deliberately does not change

- `activate(api)` as the part's entry, and the non-UI surface of `api`.
- In-process (no sandbox, no webview) — the extension runs in the host
  document, it just mounts into a host-provided node rather than
  rendering into the host's React tree.
- One bundled part file per surface.
- The package directory as source of truth, and grants in `settings.json`.
- Every non-GUI loader, and the `bin/` symlinks.

**Does change:** the UI-returning registration callbacks move from
`() => El` to `(host: HTMLElement) => Dispose | void`, and the single
shared-React constraint is gone (each extension owns its React). The four
existing gui extensions register through the old shape and must be
adapted — but that adaptation is small (wrap today's returned element in
a `createRoot(host).render(...)`), and inline styling still works
throughout.

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

1. **Bundled React vs. host-provided external.** Default is
   bring-your-own (keeps the tooling standard, no shim). Should the host
   ALSO offer React as an opt-in build-time external for authors who want
   the smaller bundle? If so, that external is a normal module the host
   resolves when it evaluates the bundle — the extension still writes
   standard `import`s and standard JSX; only its build config marks
   `react`/`react-dom` external. Lean: ship bring-your-own first, add the
   optional external later if bundle size becomes a real complaint. And
   consider recommending **Preact** in the scaffold as the small default,
   since it's ~4KB and drop-in for this use.
2. **Safelist breadth for the shipped utility stylesheet** — too small
   frustrates authors, too large bloats the always-loaded CSS. Start from
   the utilities the existing four gui extensions actually use, plus the
   obvious layout/spacing/typography set, and grow it from real
   extensions.
3. **CSS Module injection lifetime** — inject-on-mount / remove-on-unmount
   vs. inject-once-and-leave. Hashed names make leaving it harmless;
   removing it on the disposer is tidier. Minor.
4. **Whether `fez create` is a new CLI verb or part of `fez pack`'s
   package** — naming only; decide when the CLI surface is touched.

## Done when

- The desktop GUI loads extensions by scanning `packages/*/` and reading
  each manifest's `gui` part; `gui-extensions/` symlinks are gone and the
  migration removes existing ones, with no window where the GUI loses its
  extensions.
- An author can write a GUI extension as a standard React app that
  `mount`s into the host node, style it with `fez-*` Tailwind utilities
  that follow the live theme, use a CSS Module for custom styling, and
  never type `h()`, a bare hex color, or any fez-specific build config.
- `fez create` emits a scaffold that builds and loads with the token
  utilities, the mount pattern, and the capability guard already in place.
- The four existing gui extensions (bazaar, wallet, loom, themes) are
  adapted to the `mount(host)` callback and still render (inline styles
  keep working); at least one is migrated to the full pattern (mount +
  utilities) as the reference.
- The pattern is proven on GUI and documented well enough that converting
  a second surface later is a mechanical follow-on.
