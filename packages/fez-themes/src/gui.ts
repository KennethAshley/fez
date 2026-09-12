/**
 * fez-themes — the classics, mapped onto fez's eighteen tokens.
 *
 * Every pack is a light/dark pair so "auto" follows the OS. Mapping is
 * semantic, not literal: a theme's SIGNATURE color becomes --accent
 * (Dracula's purple, Nord's frost, Everforest's green), its grounds
 * become bg0/bg1/bg2, its own light variant supplies the day side —
 * never an inversion. Values come from each project's published
 * palette; where a token has no upstream equivalent (fez's --bg-mine
 * pool, the rail, a hairline) it is derived from the palette's own
 * grounds and tinted toward the accent, and marked `derived`.
 *
 * Fonts are deliberately untouched: these are color themes, and the
 * default mono stack stays.
 *
 * Sources (all MIT unless noted):
 *   Dracula + Alucard  draculatheme.com / github.com/dracula
 *   Nord               nordtheme.com (light = Snow Storm grounds, derived)
 *   Catppuccin         catppuccin.com (Mocha / Latte)
 *   Solarized          ethanschoonover.com/solarized
 *   One Dark / Light   Atom (github.com/atom/atom)
 *   Tokyo Night        github.com/folke/tokyonight.nvim (Night / Day)
 *   GitHub             github.com/primer + github-vscode-theme
 *   Rosé Pine          rosepinetheme.com (Main / Dawn)
 *   Everforest         github.com/sainnhe/everforest (Medium / Light)
 */

type ThemeVars = Record<string, string>;

const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

/** The five tokens every pack repeats mechanically. */
const common = (vars: { accent: string; green: string; red: string }) => ({
  "--brand": vars.accent,
  "--viz-ok": vars.green,
  "--viz-fail": vars.red,
  "--font-mono": MONO,
});

const themes: Record<string, { light: ThemeVars; dark: ThemeVars }> = {
  // ── Dracula / Alucard ──────────────────────────────────────────────
  "dracula": {
    dark: {
      "--bg0": "#282a36",
      "--field": "#282a36",
      "--bg1": "#2f3240", // derived: between bg and current-line
      "--bg2": "#44475a",
      "--bg-rail": "#21222c", // the VS Code port's sidebar
      "--bg-mine": "#3c2a50", // derived: purple pool
      "--fg": "#f8f8f2",
      "--fg-dim": "#6272a4",
      "--hairline": "#44475a",
      "--accent": "#bd93f9",
      "--green": "#50fa7b",
      "--red": "#ff5555",
      "--yellow": "#f1fa8c",
      "--phosphor": "#50fa7b",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#bd93f9", green: "#50fa7b", red: "#ff5555" }),
    },
    light: {
      // Alucard — Dracula's own light variant.
      "--bg0": "#fffbeb",
      "--field": "#fffbeb",
      "--bg1": "#f7f2df", // derived
      "--bg2": "#ece5cc", // derived
      "--bg-rail": "#f5efdb", // derived
      "--bg-mine": "#ede7fb", // derived: purple pool
      "--fg": "#1f1f1f",
      "--fg-dim": "#6c664b",
      "--hairline": "#e6dfc8", // derived
      "--accent": "#644ac9",
      "--green": "#14710a",
      "--red": "#cb3a2a",
      "--yellow": "#846e15",
      "--phosphor": "#14710a",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#644ac9", green: "#14710a", red: "#cb3a2a" }),
    },
  },

  // ── Nord ───────────────────────────────────────────────────────────
  "nord": {
    dark: {
      "--bg0": "#2e3440",
      "--field": "#2e3440",
      "--bg1": "#3b4252",
      "--bg2": "#434c5e",
      "--bg-rail": "#272c36", // derived
      "--bg-mine": "#37475a", // derived: frost pool
      "--fg": "#eceff4",
      "--fg-dim": "#616e88", // the community comment color; nord3 proper is too dark to read
      "--hairline": "#434c5e",
      "--accent": "#88c0d0",
      "--green": "#a3be8c",
      "--red": "#bf616a",
      "--yellow": "#ebcb8b",
      "--phosphor": "#a3be8c",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#88c0d0", green: "#a3be8c", red: "#bf616a" }),
    },
    light: {
      // Nord ships no official light theme — this is Snow Storm as the
      // grounds with Polar Night as ink and the frost accents darkened
      // for paper. Derived, and labeled so.
      "--bg0": "#eceff4",
      "--field": "#eceff4",
      "--bg1": "#e5e9f0",
      "--bg2": "#d8dee9",
      "--bg-rail": "#e5e9f0",
      "--bg-mine": "#dbe7ec", // derived: frost pool
      "--fg": "#2e3440",
      "--fg-dim": "#4c566a",
      "--hairline": "#c9d2e0", // derived
      "--accent": "#5e81ac", // nord10 — frost with contrast on paper
      "--green": "#5e7a4a", // derived: nord14 darkened
      "--red": "#a54049", // derived: nord11 darkened
      "--yellow": "#8a6f2e", // derived: nord13 darkened
      "--phosphor": "#5e7a4a",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#5e81ac", green: "#5e7a4a", red: "#a54049" }),
    },
  },

  // ── Catppuccin (Mocha / Latte) ─────────────────────────────────────
  "catppuccin": {
    dark: {
      "--bg0": "#1e1e2e", // base
      "--field": "#1e1e2e",
      "--bg1": "#181825", // mantle
      "--bg2": "#313244", // surface0
      "--bg-rail": "#11111b", // crust
      "--bg-mine": "#2e2b45", // derived: mauve pool
      "--fg": "#cdd6f4", // text
      "--fg-dim": "#7f849c", // overlay1
      "--hairline": "#313244",
      "--accent": "#cba6f7", // mauve
      "--green": "#a6e3a1",
      "--red": "#f38ba8",
      "--yellow": "#f9e2af",
      "--phosphor": "#a6e3a1",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#cba6f7", green: "#a6e3a1", red: "#f38ba8" }),
    },
    light: {
      "--bg0": "#eff1f5", // latte base
      "--field": "#eff1f5",
      "--bg1": "#e6e9ef", // mantle
      "--bg2": "#dce0e8", // crust
      "--bg-rail": "#e6e9ef",
      "--bg-mine": "#e9defa", // derived: mauve pool
      "--fg": "#4c4f69", // text
      "--fg-dim": "#8c8fa1", // overlay1
      "--hairline": "#ccd0da", // surface0
      "--accent": "#8839ef", // mauve
      "--green": "#40a02b",
      "--red": "#d20f39",
      "--yellow": "#df8e1d",
      "--phosphor": "#40a02b",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#8839ef", green: "#40a02b", red: "#d20f39" }),
    },
  },

  // ── Solarized ──────────────────────────────────────────────────────
  "solarized": {
    dark: {
      "--bg0": "#002b36", // base03
      "--field": "#002b36",
      "--bg1": "#073642", // base02
      "--bg2": "#104a56", // derived
      "--bg-rail": "#00252f", // derived
      "--bg-mine": "#0a3a52", // derived: blue pool
      "--fg": "#93a1a1", // base1 — solarized's own emphasized body
      "--fg-dim": "#586e75", // base01
      "--hairline": "#104a56",
      "--accent": "#268bd2", // blue
      "--green": "#859900",
      "--red": "#dc322f",
      "--yellow": "#b58900",
      "--phosphor": "#859900",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#268bd2", green: "#859900", red: "#dc322f" }),
    },
    light: {
      "--bg0": "#fdf6e3", // base3
      "--field": "#fdf6e3",
      "--bg1": "#eee8d5", // base2
      "--bg2": "#e4dcc4", // derived
      "--bg-rail": "#f3ecd9", // derived
      "--bg-mine": "#e0e8ee", // derived: blue pool
      "--fg": "#586e75", // base01 — solarized's emphasized ink on paper
      "--fg-dim": "#93a1a1", // base1
      "--hairline": "#d9d2c0", // derived
      "--accent": "#268bd2",
      "--green": "#859900",
      "--red": "#dc322f",
      "--yellow": "#b58900",
      "--phosphor": "#859900",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#268bd2", green: "#859900", red: "#dc322f" }),
    },
  },

  // ── One Dark / One Light (Atom) ────────────────────────────────────
  "one": {
    dark: {
      "--bg0": "#282c34",
      "--field": "#282c34",
      "--bg1": "#2c313a",
      "--bg2": "#3b4048",
      "--bg-rail": "#21252b",
      "--bg-mine": "#2c3a4e", // derived: blue pool
      "--fg": "#abb2bf",
      "--fg-dim": "#5c6370",
      "--hairline": "#3b4048",
      "--accent": "#61afef", // blue
      "--green": "#98c379",
      "--red": "#e06c75",
      "--yellow": "#e5c07b",
      "--phosphor": "#98c379",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#61afef", green: "#98c379", red: "#e06c75" }),
    },
    light: {
      "--bg0": "#fafafa",
      "--field": "#fafafa",
      "--bg1": "#f0f0f1",
      "--bg2": "#e5e5e6",
      "--bg-rail": "#eaeaeb",
      "--bg-mine": "#e2ebfd", // derived: blue pool
      "--fg": "#383a42",
      "--fg-dim": "#696c77",
      "--hairline": "#dbdbdc",
      "--accent": "#4078f2",
      "--green": "#50a14f",
      "--red": "#e45649",
      "--yellow": "#c18401",
      "--phosphor": "#50a14f",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#4078f2", green: "#50a14f", red: "#e45649" }),
    },
  },

  // ── Tokyo Night (Night / Day) ──────────────────────────────────────
  "tokyo-night": {
    dark: {
      "--bg0": "#1a1b26",
      "--field": "#1a1b26",
      "--bg1": "#16161e", // the port's own darker sidebar ground
      "--bg2": "#292e42",
      "--bg-rail": "#16161e",
      "--bg-mine": "#1f2b45", // derived: blue pool
      "--fg": "#c0caf5",
      "--fg-dim": "#565f89",
      "--hairline": "#292e42",
      "--accent": "#7aa2f7", // blue
      "--green": "#9ece6a",
      "--red": "#f7768e",
      "--yellow": "#e0af68",
      "--phosphor": "#9ece6a",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#7aa2f7", green: "#9ece6a", red: "#f7768e" }),
    },
    light: {
      "--bg0": "#e1e2e7",
      "--field": "#e1e2e7",
      "--bg1": "#d5d6db", // derived
      "--bg2": "#c8c9d1", // derived
      "--bg-rail": "#d0d1db",
      "--bg-mine": "#d4defa", // derived: blue pool
      "--fg": "#3760bf", // day's own ink is blue
      "--fg-dim": "#7a82a8", // derived from day's comment
      "--hairline": "#c8c9d1",
      "--accent": "#2e7de9",
      "--green": "#587539",
      "--red": "#f52a65",
      "--yellow": "#8c6c3e",
      "--phosphor": "#587539",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#2e7de9", green: "#587539", red: "#f52a65" }),
    },
  },

  // ── GitHub ─────────────────────────────────────────────────────────
  "github": {
    dark: {
      "--bg0": "#0d1117", // canvas.default
      "--field": "#0d1117",
      "--bg1": "#161b22", // canvas.subtle
      "--bg2": "#21262d",
      "--bg-rail": "#010409", // canvas.inset
      "--bg-mine": "#10233d", // derived: accent pool
      "--fg": "#c9d1d9",
      "--fg-dim": "#8b949e",
      "--hairline": "#30363d", // border.default
      "--accent": "#58a6ff",
      "--green": "#3fb950",
      "--red": "#f85149",
      "--yellow": "#d29922",
      "--phosphor": "#3fb950",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#58a6ff", green: "#3fb950", red: "#f85149" }),
    },
    light: {
      "--bg0": "#ffffff",
      "--field": "#ffffff",
      "--bg1": "#f6f8fa",
      "--bg2": "#eaeef2",
      "--bg-rail": "#f6f8fa",
      "--bg-mine": "#ddf4ff", // primer's accent.subtle — not derived, theirs
      "--fg": "#24292f",
      "--fg-dim": "#57606a",
      "--hairline": "#d0d7de",
      "--accent": "#0969da",
      "--green": "#1a7f37",
      "--red": "#cf222e",
      "--yellow": "#9a6700",
      "--phosphor": "#1a7f37",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#0969da", green: "#1a7f37", red: "#cf222e" }),
    },
  },

  // ── Rosé Pine (Main / Dawn) ────────────────────────────────────────
  // No literal green in this palette: pine plays status-green, foam
  // plays the live phosphor. That's the theme's own vocabulary.
  "rose-pine": {
    dark: {
      "--bg0": "#191724", // base
      "--field": "#191724",
      "--bg1": "#1f1d2e", // surface
      "--bg2": "#26233a", // overlay
      "--bg-rail": "#16141f", // derived
      "--bg-mine": "#2b2540", // derived: iris pool
      "--fg": "#e0def4", // text
      "--fg-dim": "#908caa", // subtle
      "--hairline": "#26233a",
      "--accent": "#ebbcba", // rose
      "--green": "#31748f", // pine
      "--red": "#eb6f92", // love
      "--yellow": "#f6c177", // gold
      "--phosphor": "#9ccfd8",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // foam
      ...common({ accent: "#ebbcba", green: "#31748f", red: "#eb6f92" }),
    },
    light: {
      "--bg0": "#faf4ed", // dawn base
      "--field": "#faf4ed",
      "--bg1": "#fffaf3", // surface
      "--bg2": "#f2e9e1", // overlay
      "--bg-rail": "#f4ede4", // derived
      "--bg-mine": "#f7e2de", // derived: rose pool
      "--fg": "#575279", // text
      "--fg-dim": "#797593", // subtle
      "--hairline": "#dfdad9", // highlight-med
      "--accent": "#d7827e", // rose
      "--green": "#286983", // pine
      "--red": "#b4637a", // love
      "--yellow": "#ea9d34", // gold
      "--phosphor": "#56949f",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // foam
      ...common({ accent: "#d7827e", green: "#286983", red: "#b4637a" }),
    },
  },

  // ── Everforest (Medium / Light) ────────────────────────────────────
  "everforest": {
    dark: {
      "--bg0": "#2d353b",
      "--field": "#2d353b",
      "--bg1": "#272e33", // bg_dim
      "--bg2": "#3d484d",
      "--bg-rail": "#232a2e", // derived
      "--bg-mine": "#384540", // derived: green pool
      "--fg": "#d3c6aa",
      "--fg-dim": "#859289", // grey1
      "--hairline": "#3d484d",
      "--accent": "#a7c080", // the forest green IS the signature
      "--green": "#a7c080",
      "--red": "#e67e80",
      "--yellow": "#dbbc7f",
      "--phosphor": "#83c092",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // aqua
      ...common({ accent: "#a7c080", green: "#a7c080", red: "#e67e80" }),
    },
    light: {
      "--bg0": "#fdf6e3",
      "--field": "#fdf6e3",
      "--bg1": "#f4f0d9",
      "--bg2": "#efebd4",
      "--bg-rail": "#f4f0d9",
      "--bg-mine": "#ecf0d9", // derived: green pool
      "--fg": "#5c6a72",
      "--fg-dim": "#939f91",
      "--hairline": "#e6e2cc", // derived
      "--accent": "#8da101",
      "--green": "#8da101",
      "--red": "#f85552",
      "--yellow": "#dfa000",
      "--phosphor": "#35a77c",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // aqua
      ...common({ accent: "#8da101", green: "#8da101", red: "#f85552" }),
    },
  },

  // ── Monokai ────────────────────────────────────────────────────────
  // The classic TextMate/Sublime palette as VS Code ships it (MIT). No
  // official light exists; the day side is the palette re-inked on warm
  // paper — every value derived and marked.
  "monokai": {
    dark: {
      "--bg0": "#272822",
      "--field": "#272822",
      "--bg1": "#1e1f1c", // the port's sidebar
      "--bg2": "#3e3d32", // selection
      "--bg-rail": "#1e1f1c",
      "--bg-mine": "#3a2634", // derived: pink pool
      "--fg": "#f8f8f2",
      "--fg-dim": "#75715e",
      "--hairline": "#3e3d32",
      "--accent": "#f92672", // the pink IS monokai
      "--green": "#a6e22e",
      "--red": "#fd5c5c", // derived: status red kept apart from the pink accent
      "--yellow": "#e6db74",
      "--phosphor": "#a6e22e",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#f92672", green: "#a6e22e", red: "#fd5c5c" }),
    },
    light: {
      "--bg0": "#fafaf5", // derived throughout — monokai ships no light
      "--field": "#fafaf5",
      "--bg1": "#f0f0ea",
      "--bg2": "#e3e3da",
      "--bg-rail": "#eeeee7",
      "--bg-mine": "#f7e0ea",
      "--fg": "#272822",
      "--fg-dim": "#75715e",
      "--hairline": "#d8d8cd",
      "--accent": "#d81b60",
      "--green": "#6b9500",
      "--red": "#c7434b",
      "--yellow": "#9d8a00",
      "--phosphor": "#6b9500",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#d81b60", green: "#6b9500", red: "#c7434b" }),
    },
  },

  // ── Night Owl / Light Owl (sdras) ──────────────────────────────────
  "night-owl": {
    dark: {
      "--bg0": "#011627",
      "--field": "#011627",
      "--bg1": "#001122", // its own sidebar
      "--bg2": "#0b2942",
      "--bg-rail": "#000c1d", // its activity bar
      "--bg-mine": "#12314f", // derived: blue pool
      "--fg": "#d6deeb",
      "--fg-dim": "#637777",
      "--hairline": "#102a44", // its sidebar border
      "--accent": "#82aaff",
      "--green": "#c5e478",
      "--red": "#ef5350",
      "--yellow": "#f78c6c",
      "--phosphor": "#7fdbca",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // the owl's cyan
      ...common({ accent: "#82aaff", green: "#c5e478", red: "#ef5350" }),
    },
    light: {
      // Light Owl — the official day side: purple and teal on near-white.
      "--bg0": "#fbfbfb",
      "--field": "#fbfbfb",
      "--bg1": "#f0f0f0",
      "--bg2": "#e4e4e4", // derived
      "--bg-rail": "#f0f0f0",
      "--bg-mine": "#efe3f8", // derived: purple pool
      "--fg": "#403f53",
      "--fg-dim": "#989fb1",
      "--hairline": "#d9d9d9", // derived
      "--accent": "#994cc3",
      "--green": "#2aa298", // Light Owl speaks teal where others speak green
      "--red": "#e64d49",
      "--yellow": "#daaa01",
      "--phosphor": "#0c969b",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#994cc3", green: "#2aa298", red: "#e64d49" }),
    },
  },

  // ── Ayu (Dark / Light) ─────────────────────────────────────────────
  "ayu": {
    dark: {
      "--bg0": "#0b0e14",
      "--field": "#0b0e14",
      "--bg1": "#0f131a", // derived lift
      "--bg2": "#161a24", // its own line color
      "--bg-rail": "#090c12", // derived
      "--bg-mine": "#2a2416", // derived: amber pool
      "--fg": "#bfbdb6",
      "--fg-dim": "#565b66",
      "--hairline": "#161a24",
      "--accent": "#e6b450", // the ayu amber
      "--green": "#aad94c",
      "--red": "#d95757",
      "--yellow": "#ffb454",
      "--phosphor": "#aad94c",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#e6b450", green: "#aad94c", red: "#d95757" }),
    },
    light: {
      "--bg0": "#fcfcfc",
      "--field": "#fcfcfc",
      "--bg1": "#f3f4f5", // derived
      "--bg2": "#e7e8e9", // derived
      "--bg-rail": "#f3f4f5",
      "--bg-mine": "#fff3e0", // derived: amber pool
      "--fg": "#5c6166",
      "--fg-dim": "#8a9199",
      "--hairline": "#e0e1e2", // derived
      "--accent": "#e6820c", // derived: ayu's #ffaa33 darkened for paper
      "--green": "#86b300",
      "--red": "#e65050",
      "--yellow": "#a37a00", // derived: #f2ae49 darkened for paper
      "--phosphor": "#86b300",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#e6820c", green: "#86b300", red: "#e65050" }),
    },
  },

  // ── Palenight / Material Lighter ───────────────────────────────────
  "palenight": {
    dark: {
      "--bg0": "#292d3e",
      "--field": "#292d3e",
      "--bg1": "#222634", // derived: panels a shade down
      "--bg2": "#3a3f58", // derived
      "--bg-rail": "#1b1e2b", // its own darker ground
      "--bg-mine": "#35304e", // derived: purple pool
      "--fg": "#a6accd",
      "--fg-dim": "#676e95",
      "--hairline": "#3a3f58",
      "--accent": "#c792ea",
      "--green": "#c3e88d",
      "--red": "#f07178",
      "--yellow": "#ffcb6b",
      "--phosphor": "#c3e88d",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#c792ea", green: "#c3e88d", red: "#f07178" }),
    },
    light: {
      // Material Lighter — palenight's sibling day side.
      "--bg0": "#fafafa",
      "--field": "#fafafa",
      "--bg1": "#f0f1f4", // derived
      "--bg2": "#e4e7ec", // derived
      "--bg-rail": "#eceff1",
      "--bg-mine": "#ede7f6", // derived: purple pool
      "--fg": "#546e7a",
      "--fg-dim": "#90a4ae",
      "--hairline": "#d5dbe0", // derived
      "--accent": "#7c4dff",
      "--green": "#91b859",
      "--red": "#e53935",
      "--yellow": "#f6a434",
      "--phosphor": "#91b859",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#7c4dff", green: "#91b859", red: "#e53935" }),
    },
  },

  // ── Horizon (Dark / Bright) ────────────────────────────────────────
  "horizon": {
    dark: {
      "--bg0": "#1c1e26",
      "--field": "#2e303e", // its own input ground
      "--bg1": "#232530",
      "--bg2": "#2e303e",
      "--bg-rail": "#1a1c23", // derived
      "--bg-mine": "#33222c", // derived: coral pool
      "--fg": "#d5d8da",
      "--fg-dim": "#6c6f93",
      "--hairline": "#2e303e",
      "--accent": "#e95678", // the coral
      "--green": "#29d398",
      "--red": "#f43e5c", // derived: status red kept apart from the coral
      "--yellow": "#fab795",
      "--phosphor": "#59e1e3",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#e95678", green: "#29d398", red: "#f43e5c" }),
    },
    light: {
      // Horizon Bright — the official day side.
      "--bg0": "#fdf0ed",
      "--field": "#f9cbbe", // its own input ground
      "--bg1": "#f9e8e2", // derived
      "--bg2": "#f0dcd5", // derived
      "--bg-rail": "#f7e5df", // derived
      "--bg-mine": "#fbdcd5", // derived: coral pool
      "--fg": "#06060c",
      "--fg-dim": "#7a6c76", // derived
      "--hairline": "#ead4cc", // derived
      "--accent": "#e84a72",
      "--green": "#0e9e6e", // derived: terminal green darkened for paper
      "--red": "#d6335f", // derived
      "--yellow": "#c67432", // derived: #f77d26 darkened for paper
      "--phosphor": "#0f9fa1",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // derived: cyan darkened
      ...common({ accent: "#e84a72", green: "#0e9e6e", red: "#d6335f" }),
    },
  },

  // ── SynthWave '84 (Robb Owen) ──────────────────────────────────────
  "synthwave-84": {
    dark: {
      "--bg0": "#262335",
      "--field": "#262335",
      "--bg1": "#241b2f", // its own panel ground
      "--bg2": "#34294f", // derived
      "--bg-rail": "#1e1a29", // derived
      "--bg-mine": "#3b2352", // derived: neon pool
      "--fg": "#f0eff1",
      "--fg-dim": "#848bbd",
      "--hairline": "#34294f",
      "--accent": "#ff7edb", // the neon pink
      "--green": "#72f1b8",
      "--red": "#fe4450",
      "--yellow": "#fede5d",
      "--phosphor": "#36f9f6",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // the glow
      ...common({ accent: "#ff7edb", green: "#72f1b8", red: "#fe4450" }),
    },
    light: {
      // No official day in 1984 — a derived sunrise: same neons, inked
      // down onto pale violet paper. Every value derived.
      "--bg0": "#fdf6fb",
      "--field": "#fdf6fb",
      "--bg1": "#f7ecf5",
      "--bg2": "#eeddeb",
      "--bg-rail": "#f5e9f2",
      "--bg-mine": "#fbdff0",
      "--fg": "#2a2139",
      "--fg-dim": "#7a6f8f",
      "--hairline": "#e5d2e2",
      "--accent": "#c9256e",
      "--green": "#0b8a5f",
      "--red": "#d1244a",
      "--yellow": "#9a7b00",
      "--phosphor": "#0f8f8c",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#c9256e", green: "#0b8a5f", red: "#d1244a" }),
    },
  },

  // ── Cobalt2 (Wes Bos) ──────────────────────────────────────────────
  "cobalt2": {
    dark: {
      "--bg0": "#193549",
      "--field": "#193549",
      "--bg1": "#15232d", // its own sidebar
      "--bg2": "#1f4662", // its own highlight
      "--bg-rail": "#122738", // derived
      "--bg-mine": "#1f4662",
      "--fg": "#ffffff",
      "--fg-dim": "#7d9ca8", // derived
      "--hairline": "#234e6d", // derived
      "--accent": "#ffc600", // the cobalt2 yellow
      "--green": "#3ad900",
      "--red": "#ff628c",
      "--yellow": "#ff9d00",
      "--phosphor": "#2affdf",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#ffc600", green: "#3ad900", red: "#ff628c" }),
    },
    light: {
      // No official light — derived: the blueprint flipped to paper,
      // yellow inked down to stay readable.
      "--bg0": "#f5f9fc",
      "--field": "#f5f9fc",
      "--bg1": "#eaf1f7",
      "--bg2": "#dbe7f0",
      "--bg-rail": "#e8f0f6",
      "--bg-mine": "#fdf3d0",
      "--fg": "#17384c",
      "--fg-dim": "#5a7385",
      "--hairline": "#cddbe6",
      "--accent": "#b78a00",
      "--green": "#2b8a00",
      "--red": "#d6336c",
      "--yellow": "#a66b00",
      "--phosphor": "#0d8f7a",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#b78a00", green: "#2b8a00", red: "#d6336c" }),
    },
  },

  // ── Zenburn ────────────────────────────────────────────────────────
  "zenburn": {
    dark: {
      "--bg0": "#3f3f3f",
      "--field": "#3f3f3f",
      "--bg1": "#383838", // derived
      "--bg2": "#4f4f4f", // derived
      "--bg-rail": "#363636", // derived
      "--bg-mine": "#4a4738", // derived: parchment pool
      "--fg": "#dcdccc",
      "--fg-dim": "#8f8f8f", // derived
      "--hairline": "#4f4f4f",
      "--accent": "#f0dfaf", // zenburn's washed parchment
      "--green": "#7f9f7f",
      "--red": "#cc9393",
      "--yellow": "#e0cf9f",
      "--phosphor": "#8cd0d3",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#f0dfaf", green: "#7f9f7f", red: "#cc9393" }),
    },
    light: {
      // Zenburn has no light side — this is the same low-contrast calm
      // on warm gray paper. Every value derived.
      "--bg0": "#f0efe6",
      "--field": "#f0efe6",
      "--bg1": "#e8e6db",
      "--bg2": "#dbd8ca",
      "--bg-rail": "#e6e4d8",
      "--bg-mine": "#eee9d2",
      "--fg": "#3f3f3f",
      "--fg-dim": "#7c7b68",
      "--hairline": "#d0cdbd",
      "--accent": "#8f7f3f",
      "--green": "#5f7f5f",
      "--red": "#a05656",
      "--yellow": "#8a7a3a",
      "--phosphor": "#4a8f8f",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#8f7f3f", green: "#5f7f5f", red: "#a05656" }),
    },
  },

  // ── Kanagawa (Wave / Lotus) ────────────────────────────────────────
  "kanagawa": {
    dark: {
      "--bg0": "#1f1f28", // sumiInk1
      "--field": "#1f1f28",
      "--bg1": "#16161d", // sumiInk0
      "--bg2": "#2a2a37", // sumiInk2
      "--bg-rail": "#16161d",
      "--bg-mine": "#223249", // waveBlue1 — the palette's own pool
      "--fg": "#dcd7ba", // fujiWhite
      "--fg-dim": "#727169", // fujiGray
      "--hairline": "#363646", // sumiInk3
      "--accent": "#7e9cd8", // crystalBlue
      "--green": "#98bb6c", // springGreen
      "--red": "#c34043", // autumnRed
      "--yellow": "#e6c384", // carpYellow
      "--phosphor": "#98bb6c",
      "--measure-read": "680px",
      "--measure-scan": "1100px",
      ...common({ accent: "#7e9cd8", green: "#98bb6c", red: "#c34043" }),
    },
    light: {
      // Lotus — the official day side.
      "--bg0": "#f2ecbc", // lotusWhite3
      "--field": "#f2ecbc",
      "--bg1": "#e5ddb0", // lotusWhite2
      "--bg2": "#e7dba0", // lotusWhite4
      "--bg-rail": "#dcd5ac", // lotusWhite1
      "--bg-mine": "#c7d7e0", // lotusBlue1 — the palette's own pool
      "--fg": "#545464", // lotusInk1
      "--fg-dim": "#716e61", // derived
      "--hairline": "#d5cea3", // lotusWhite0
      "--accent": "#4d699b", // lotusBlue4
      "--green": "#6f894e", // lotusGreen
      "--red": "#c84053", // lotusRed
      "--yellow": "#de9800", // lotusYellow3
      "--phosphor": "#597b75",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // lotusAqua
      ...common({ accent: "#4d699b", green: "#6f894e", red: "#c84053" }),
    },
  },

  // ── Flexoki (Steph Ango) ───────────────────────────────────────────
  // Dark uses the 400-weight accents, light the 600s — the spec's own
  // pairing for its inky paper idea.
  "flexoki": {
    dark: {
      "--bg0": "#100f0f", // black
      "--field": "#100f0f",
      "--bg1": "#1c1b1a", // base-950
      "--bg2": "#282726", // base-900
      "--bg-rail": "#1c1b1a",
      "--bg-mine": "#1e2a38", // derived: blue pool
      "--fg": "#cecdc3", // base-200
      "--fg-dim": "#878580", // base-500
      "--hairline": "#343331", // base-850
      "--accent": "#4385be", // blue-400
      "--green": "#879a39", // green-400
      "--red": "#d14d41", // red-400
      "--yellow": "#d0a215", // yellow-400
      "--phosphor": "#3aa99f",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // cyan-400
      ...common({ accent: "#4385be", green: "#879a39", red: "#d14d41" }),
    },
    light: {
      "--bg0": "#fffcf0", // paper
      "--field": "#fffcf0",
      "--bg1": "#f2f0e5", // base-50
      "--bg2": "#e6e4d9", // base-100
      "--bg-rail": "#f2f0e5",
      "--bg-mine": "#dde6ee", // derived: blue pool
      "--fg": "#100f0f", // black
      "--fg-dim": "#6f6e69", // base-600
      "--hairline": "#dad8ce", // base-150
      "--accent": "#205ea6", // blue-600
      "--green": "#66800b", // green-600
      "--red": "#af3029", // red-600
      "--yellow": "#ad8301", // yellow-600
      "--phosphor": "#24837b",
      "--measure-read": "680px",
      "--measure-scan": "1100px", // cyan-600
      ...common({ accent: "#205ea6", green: "#66800b", red: "#af3029" }),
    },
  },
};

export default { themes };
