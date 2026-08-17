/**
 * fez-tui — Fez's chat-TUI layer.
 *
 * The rendering engine is @earendil-works/pi-tui (pinned exact version):
 * raw-mode terminal, differential main-screen rendering, line editor,
 * markdown. Re-exported here so the rest of Fez imports everything
 * TUI-shaped from one place. Fez-owned chat components (Footer now;
 * message bubbles, channel sidebar later) live in this package and build
 * on the engine's Component interface.
 */
export {
  Box,
  ProcessTerminal,
  TuiMainScreen,
  TuiAltScreen,
  Container,
  ScrollView,
  VStack,
  HStack,
  Text,
  Loader,
  Markdown,
  Editor,
  visibleWidth,
  type Component,
  // (deep import below: applyBackgroundToLine has no root export upstream)
  type TUI,
  type EditorTheme,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

export { Footer } from "./footer.js";
export { SidePanel, type SidePanelSectionMeta } from "./side-panel.js";
export { markdownTheme, editorTheme, loaderColors, authorColor, timestamp, defaultTheme, setActiveTheme, getActiveTheme, compileThemeJson, type FezTheme, type StyleFn, type ThemeJson } from "./theme.js";
export { highlightCode } from "./highlight.js";
// ANSI-safe full-width background painter (pi-tui's own Text bg mechanism)
// — deep import because upstream doesn't re-export it from the root.
export { applyBackgroundToLine } from "@earendil-works/pi-tui/dist/utils.js";
