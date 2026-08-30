# @fezchat/tailwind-preset

A [Tailwind CSS](https://tailwindcss.com) preset whose `fez-*` color utilities resolve to the live [fez](https://fez.chat) theme tokens.

`bg-fez-surface` is `background-color: var(--bg1)`; when the user's theme rewrites `--bg1`, the utility repaints. Theming is automatic, and the frozen-theme class of bug is structurally impossible — every color utility is a `var()` reference, never a baked-in hex.

## Install

```sh
npm install -D @fezchat/tailwind-preset
```

Dev-only: this preset gives an extension author IntelliSense, autocomplete, and typo-checking against exactly the utilities the fez host ships at runtime. The compiled CSS itself comes from the host, so your extension bundle carries no CSS framework.

## Usage

```js
// tailwind.config.js
import fezPreset from "@fezchat/tailwind-preset";

export default {
  presets: [fezPreset],
  content: ["./src/**/*.{ts,tsx}"],
};
```

Then write theme-aware utilities:

```tsx
<div className="bg-fez-surface text-fez-fg border border-fez-hairline hover:bg-fez-elevated rounded-md p-4">
```

## The palette

Each utility maps to a theme token: `fez-fg`, `fez-dim`, `fez-surface` (`--bg1`), `fez-elevated` (`--bg2`), `fez-base` (`--bg0`), `fez-mine`, `fez-rail`, `fez-accent`, `fez-brand`, `fez-green`, `fez-red`, `fez-yellow`, `fez-hairline`, `fez-field` — usable as `bg-`, `text-`, and `border-`.

Pairs with [`@fezchat/ui`](https://www.npmjs.com/package/@fezchat/ui) for on-brand components. `fez create <name> --gui` scaffolds an extension wired to both.
