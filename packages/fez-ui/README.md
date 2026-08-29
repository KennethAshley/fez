# @fezchat/ui

The [fez](https://fez.chat) app's own UI primitives, as React components — so a GUI extension looks like a built-in view instead of a stranger's iframe.

Each component renders the **exact** class names and theme tokens the host app uses, so an extension built from them is visually indistinguishable from the app and follows every theme change for free.

## Install

```sh
npm install @fezchat/ui
# pairs with the theme-wired utility classes:
npm install -D @fezchat/tailwind-preset
```

`react` is a peer dependency — your extension bundles its own React under the fez mount model.

## Components

| Component | Use it for |
|---|---|
| `<Page wide?>` | The top-level page shell (fills rail → side pane). |
| `<PageHeader title subtitle? fact? action?>` | A page header with the app's rule and one live fact. |
| `<EmptyState line how?>` | A full-voice empty state, not a grey italic line. |
| `<Field label hint?>` | A labelled form control with a hint. |
| `<Row active? onClick?>` | A selectable row; `active` draws the ember-notch idiom. |
| `<Chip tone?>` | A skill/label chip. |
| `<Avatar pk name? size?>` | The pubkey-generated identity sprite. |

## Usage

Under the fez mount model, your extension mounts its own React root into a host-provided node:

```tsx
import { createRoot } from "react-dom/client";
import { Page, PageHeader, EmptyState } from "@fezchat/ui";

function App() {
  return (
    <Page wide>
      <PageHeader title="My tool" subtitle="Built from @fezchat/ui." fact="ready" />
      <div className="bg-fez-surface text-fez-fg rounded-md p-4">
        <EmptyState line="Nothing here yet." how="Wire up your view." />
      </div>
    </Page>
  );
}

export function activate(api) {
  api.registerNavView("my-tool", { glyph: "◆", label: "My tool" }, (host) => {
    const root = createRoot(host);
    root.render(<App />);
    return () => root.unmount();
  });
}
```

Custom bits use the `fez-*` Tailwind utilities from [`@fezchat/tailwind-preset`](https://www.npmjs.com/package/@fezchat/tailwind-preset), which resolve to the live theme tokens — never a bare hex.

## Scaffold one in a command

```sh
fez create my-tool --gui
```

emits a working extension already built from `@fezchat/ui`.

## Boundary

This library extracts the **reusable** shell / form / identity primitives and the app's idioms (the ember notch, identity-gets-a-face, the empty-room voice). Per-view styling stays in your extension — via `fez-*` utilities or a CSS module. The shell primitives are shaped for a top-level page; for content embedded inside a nav view with a custom layout, hand-authored markup on the app's classes may fit better.
