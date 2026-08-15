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
  type Component,
  type TUI,
  type EditorTheme,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

export { Footer } from "./footer.js";
export { markdownTheme, editorTheme, loaderColors } from "./theme.js";
