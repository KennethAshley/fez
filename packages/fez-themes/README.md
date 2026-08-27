# @fezchat/themes

The classics, worn by fez. Install once, pick in **Settings → theme** —
every pack is a light/dark pair, so "auto" follows your OS.

| Theme | Dark side | Light side | Upstream | License |
|---|---|---|---|---|
| `dracula` | Dracula | Alucard (official) | [draculatheme.com](https://draculatheme.com) | MIT |
| `nord` | Nord | Snow Storm (derived — Nord ships no light) | [nordtheme.com](https://www.nordtheme.com) | MIT |
| `catppuccin` | Mocha | Latte | [catppuccin.com](https://catppuccin.com) | MIT |
| `solarized` | Dark | Light | [ethanschoonover.com/solarized](https://ethanschoonover.com/solarized) | MIT |
| `one` | One Dark | One Light | [Atom](https://github.com/atom/atom) | MIT |
| `tokyo-night` | Night | Day | [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) | Apache-2.0 |
| `github` | GitHub Dark | GitHub Light | [primer](https://github.com/primer) / [github-vscode-theme](https://github.com/primer/github-vscode-theme) | MIT |
| `rose-pine` | Main | Dawn | [rosepinetheme.com](https://rosepinetheme.com) | MIT |
| `everforest` | Medium | Light | [sainnhe/everforest](https://github.com/sainnhe/everforest) | MIT |
| `monokai` | Monokai | (derived) | [VS Code](https://github.com/microsoft/vscode) / TextMate | MIT |
| `night-owl` | Night Owl | Light Owl (official) | [sdras/night-owl-vscode-theme](https://github.com/sdras/night-owl-vscode-theme) | MIT |
| `ayu` | Dark | Light | [ayu-theme](https://github.com/ayu-theme) | MIT |
| `palenight` | Palenight | Material Lighter | [Material Theme](https://github.com/material-theme) | MIT |
| `horizon` | Horizon | Bright (official) | [jolaleye/horizon-theme-vscode](https://github.com/jolaleye/horizon-theme-vscode) | MIT |
| `synthwave-84` | SynthWave '84 | (derived) | [robb0wen/synthwave-vscode](https://github.com/robb0wen/synthwave-vscode) | MIT |
| `cobalt2` | Cobalt2 | (derived) | [wesbos/cobalt2-vscode](https://github.com/wesbos/cobalt2-vscode) | MIT |
| `zenburn` | Zenburn | (derived) | Jani Nurminen's classic | permissive |
| `kanagawa` | Wave | Lotus (official) | [rebelot/kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim) | MIT |
| `flexoki` | Dark | Light | [kepano/flexoki](https://github.com/kepano/flexoki) | MIT |

Gruvbox is absent on purpose: fez's built-in **default** theme already
wears the Gruvbox palette.

## How the mapping works

fez themes are eighteen CSS tokens. Each port maps semantically, not
literally: the theme's signature color becomes `--accent`, its grounds
become `bg0/bg1/bg2`, its own light variant supplies the day side —
never an inversion. Tokens with no upstream equivalent (the `--bg-mine`
pool behind your own messages, the rail, some hairlines) are derived
from the palette's grounds and tinted toward the accent; every derived
value is marked `derived` in `src/gui.ts`. Fonts are untouched — these
are color themes.

All palettes belong to their authors; this package only re-expresses
them as fez token packs, with gratitude.
