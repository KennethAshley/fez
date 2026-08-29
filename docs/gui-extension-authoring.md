# Authoring a GUI extension

A `gui` part is a standard React app the desktop hands a DOM node to.
This page is the one-page overview; the full design is
[`docs/superpowers/specs/2026-08-28-gui-extension-dx-design.md`](superpowers/specs/2026-08-28-gui-extension-dx-design.md).

## The dev loop

```
fez create <name> --gui   # scaffold, built from @fezchat/ui
cd <name>
bun install
# edit src/view.tsx
fez pack                  # src/view.tsx → dist/view.js (+ dist/view.css if you used a CSS Module)
fez link .                # copies the gui part into ~/.fez/packages/<name>/
```

`fez link . --watch` stays resident and rebuilds/re-copies on save; the
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

The host calls your part's `mount(host)` with a DOM node it owns; you
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
  anything is copied.

## `@fezchat/ui` components

| Component | Use when |
|---|---|
| `Page` | Wrap a top-level view's content — gives it the app's `<main>` + page shell. |
| `PageHeader` | The title/subtitle/rule at the top of a `Page` — `fact` and `action` add a trailing stat or button. |
| `EmptyState` | Nothing to show yet — a full-voice line (`line`) plus an optional `how`, not a grey italic apology. |
| `Field` | A labeled form control (`label` + children + optional `hint`) — the settings-pane row shape. |
| `Row` | A list row that can be the active/chosen one — pass `active` to draw the ember-notch marker. |
| `Chip` | A small inline tag/status pill; `tone` selects a variant. |
| `Avatar` | An identity's face — a hand-drawn sprite for the named cast, a generated one from any other pubkey (`pk`). |

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
hashed by `fez pack`, which emits a companion `dist/view.css`. As of this
writing that emitted CSS is **not yet loaded by the desktop's extension
loader** — the wiring that would inject it on mount is a pending
follow-on (the loader currently always treats an extension's styles as
absent). Until that ships, the reliable way to style beyond `fez-*`
utilities is inline styles, or injecting your own `<style>` element from
inside `mount`.
