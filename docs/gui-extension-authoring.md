# Authoring a GUI extension

A `gui` part can be a standard React app running in an isolated native
child webview. `fez create <name> --gui` generates that shape, including its
navigation declaration and UI permission. This runtime requires a packaged
macOS Fez app with isolated custom-view support; `tauri dev` refuses it.

## The dev loop

```
fez create <name> --gui    # isolated React view, built from @fezchat/ui
cd <name>
npm install
# edit src/view.tsx
npm run check
npm run build             # src/view.tsx → dist/view.js (+ optional dist/view.css)
npx fez link .            # copies into ~/.fez/packages/<installed-package-name>/
```

The generated package includes the CLI as a dev dependency, so subsequent
commands work without a global install. Quit and reopen Fez, select your
extension in the navigation rail, and look for its title, **ready**, and
**Nothing here yet.**

Installation names omit the `@fezchat/` scope; other scopes become a prefix:
`@you/my-extension` installs under `~/.fez/packages/you-my-extension/`.

`npx fez link . --watch` stays resident and rebuilds/re-copies on save; the
running desktop still needs a relaunch to pick up a changed `gui` part —
there is no hot reload.

`--gui` alone is what routes `fez create` to this scaffold. `fez create`
also takes `--headless`, `--relay`, and `--workspace`, and any combination
other than `--gui` alone (including the no-flags default, which is
`--headless --gui` together) goes through the older multi-surface
scaffolder instead — that one emits a raw `api.React.createElement`/`h()`
gui starter, not this one. If you want the `@fezchat/ui` mount-model
starter, pass `--gui` and nothing else.

## The mount model

The manifest declares the navigation slot before any extension code runs:

```json
{
  "fez": {
    "parts": { "gui": "dist/view.js" },
    "guiRuntime": "isolated",
    "permissions": ["ui"],
    "guiContributions": {
      "nav": [{ "name": "my-extension", "glyph": "◆", "label": "my-extension" }]
    }
  }
}
```

Use that same `name` in `api.registerNavView`. The isolated child calls the
registered render callback with a DOM node; you
`createRoot(host).render(<App/>)` and return `() => root.unmount()` as
the disposer, which the host calls on hide/uninstall. Your extension
bundles its own React — standard JSX (`jsx: automatic`), no `h()` shim,
no fez-specific build config, no shared React with the host.

## The two rules

- **Colors come from `fez-*` Tailwind utilities** (`bg-fez-surface`,
  `text-fez-fg`, …), never a bare hex — they resolve to the live theme's
  CSS variables, so a hardcoded color is the one way to go stale when the
  user switches themes.
- **`api.*` capabilities are absent when their permission was declined**
  (e.g. `api.client` needs `read:channels`) — guard (`if (!api.client)`),
  never assert. `fez link` prints exactly what a package asks for before
  anything is copied. The starter only needs `ui`; add grants when you use
  them. The isolated adapter supports a subset of `GuiExtensionApi`, described
  in the [runtime guide](https://docs.fez.chat/extension-api/gui).

## Smoke-test the packaged runtime

In the packaged macOS app, open the generated view, switch away, and reopen
it. Check its ready screen and theme colors. Record the desktop release
tested in the extension README. `fez.minFezVersion` is the protocol host
version, which is separate from the desktop release number.

Fez contributors can run the automated check from the repository root:

```sh
node scripts/smoke-gui-starter.mjs
```

It requires macOS, Rust/Xcode tools, the repository's installed build
dependencies, and npm access. It generates through the real CLI, installs
public npm dependencies in a temporary directory, typechecks, builds and
packs the extension, then opens the packed bundle in the native WKWebView
runner with packaged assets and only `ui` permission. It checks the rendered
title, empty state, theme CSS, and isolation from main-window state. Its
fixture state is temporary; it does not install into your Fez profile.
This checks the packaged runtime, not a signed release's installer or updater.

## Starter components from `@fezchat/ui`

These page styles and the `fez-*` utilities are shared by the main app and
isolated children. Other main-app selectors are not automatically available
inside a child; use a companion stylesheet for additional components.

| Component | Use when |
|---|---|
| `Page` | Wrap a top-level view's content — gives it the app's `<main>` + page shell. |
| `PageHeader` | The title/subtitle/rule at the top of a `Page` — `fact` and `action` add a trailing stat or button. |
| `EmptyState` | Nothing to show yet — a full-voice line (`line`) plus an optional `how`, not a grey italic apology. |

**Honest caveat:** `Page`/`PageHeader`/`EmptyState` are shaped for a
top-level page — they add their own `<main>` wrapper, one "fact", and a
two-line empty state. If you're rendering inside a nav view with a custom
layout (a gallery, a multi-pane tool), those wrappers can fight your own
structure. In that case, hand-authored markup styled with `fez-*`
utilities (or classNames borrowed from the app, same as any hand-rolled
view) fits better than forcing the shell primitives. `packages/fez-loom/src/gui.tsx`
is the in-tree example: its nav view deliberately renders a bare
`fez-page` div instead of `<Page>`, because `<Page>` would nest a second
`<main>`.

## Styling beyond `fez-*` utilities

A `*.module.css` you import from `src/view.tsx` gets its class names
hashed by `fez pack`, which emits a companion CSS file beside your gui
bundle (`dist/gui.js` → `dist/gui.css`). The desktop loader reads that
companion file and injects it into the isolated child when your extension
activates. Styles stay inside that child's document.

Inline styles and injecting your own `<style>` from inside `mount` also
work if you prefer them — but reach for a `fez-*` utility or a theme token
(`var(--brand)`) over a bare hex, so your styling still follows the theme.
