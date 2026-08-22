/**
 * The built-in palette — pure data, deliberately in a module of its own.
 *
 * It used to live in gui-extensions.ts, which imports React and Tauri and
 * touches `document`. A theme-token eval reads this constant to check
 * that every CSS variable App.css declares is actually supplied, and
 * importing it from there dragged the whole GUI surface into a Node
 * tsconfig with no DOM lib — four type errors about `document` and
 * `matchMedia` in a file that is perfectly correct where it runs.
 *
 * The constant never needed any of that. Keep this file import-free so a
 * Node test can read it without pretending to be a browser.
 *
 * Both ways up: gruvbox dark (what App.css has always shipped, kept
 * byte-identical so "default" looks unchanged) and gruvbox light, its
 * canonical counterpart. It is here rather than in CSS because "default"
 * has to be resolvable like any other theme — the same paint() picks the
 * variant, so following the OS is one code path instead of a special case.
 */
export const BUILT_IN_DEFAULT = {
  dark: {
    "--bg0": "#1d2021",
    "--field": "#1d2021",
    "--bg1": "#282828",
    "--bg2": "#3c3836",
    "--bg-mine": "#2d3a40",
    "--fg": "#ebdbb2",
    "--fg-dim": "#928374",
    "--accent": "#83a598",
    "--green": "#b8bb26",
    "--red": "#fb4934",
    "--yellow": "#fabd2f",
    "--brand": "#FF6A00",
    // The terminal-chrome layer. These were hard-coded in App.css and
    // are the reason a light theme used to leave a black sidebar with
    // near-black text on it — invisible, and the first thing anyone
    // noticed.
    "--bg-rail": "#17191a",
    "--hairline": "#32302f",
    "--phosphor": "#b8bb26",
    // Chart marks, CVD-validated against their ground — a pair, not
    // theme accents, so they are tuned per scheme rather than reused.
    "--viz-ok": "#43a56c",
    "--viz-fail": "#fb4934",
    "--font-mono": 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
  },
  light: {
    "--bg0": "#fbf1c7",
    "--field": "#fbf1c7",
    "--bg1": "#f2e5bc",
    "--bg2": "#e0d5b0",
    // Your own messages: a cool tint, same role the dark side gives it.
    "--bg-mine": "#dbe4e6",
    "--fg": "#3c3836",
    "--fg-dim": "#7c6f64",
    // Gruvbox light's accents are darkened on purpose — the dark set's
    // pastels have nowhere near enough contrast on paper.
    "--accent": "#076678",
    "--green": "#79740e",
    "--red": "#9d0006",
    "--yellow": "#b57614",
    "--brand": "#d45500",
    "--bg-rail": "#eee0b7",
    "--hairline": "#d5c4a1",
    "--phosphor": "#79740e",
    "--viz-ok": "#427b58",
    "--viz-fail": "#9d0006",
    "--font-mono": 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
  },
};
