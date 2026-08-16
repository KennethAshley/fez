/**
 * Example theme pack — install by copying into ~/.fez/extensions/, then
 * `/theme nightfall` in the TUI (persisted across sessions).
 *
 * A pack is a normal fez extension: default-exported function, single
 * self-contained file. It can't resolve chalk from the extensions dir,
 * so style functions are raw ANSI (256-color) — which also makes packs
 * dependency-free by construction. Only the tokens you set override the
 * default theme; everything omitted falls through.
 */
const fg = (n) => (s) => `\x1b[38;5;${n}m${s}\x1b[39m`;
const bg = (n) => (s) => `\x1b[48;5;${n}m${s}\x1b[49m`;
const bold = (paint) => (s) => `\x1b[1m${paint(s)}\x1b[22m`;
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const italic = (paint) => (s) => `\x1b[3m${paint(s)}\x1b[23m`;

export default function activate(api) {
  api.registerTheme({
    name: "nightfall",
    you: bold(fg(75)),        // sky blue
    brand: bold(fg(135)),     // violet
    authorPalette: [bold(fg(114)), bold(fg(216)), bold(fg(80)), bold(fg(210)), bold(fg(147)), bold(fg(222))],
    timestamp: fg(60),
    dim,
    accent: fg(80),           // teal
    error: bold(fg(203)),
    banner: fg(99),           // deep violet block logo
    sidebarBg: bg(234),       // near-black pane
    loader: { spinner: fg(135), message: dim },
    markdown: {
      heading: bold(fg(222)),
      link: (s) => `\x1b[4m${fg(80)(s)}\x1b[24m`,
      code: fg(216),
      listBullet: fg(135),
      quote: italic(fg(60)),
    },
  });
}
