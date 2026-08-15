import chalk from "chalk";
import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

/**
 * Fez's chalk-based themes for pi-tui components — the one place visual
 * identity lives, so tui.ts and any future component pull from here
 * instead of scattering chalk calls per call site. Derived from the
 * palette the original pi-tui proof used (git 9285628's demo.ts).
 */

export const markdownTheme: MarkdownTheme = {
  heading: (t) => chalk.bold.yellow(t),
  link: (t) => chalk.cyan.underline(t),
  linkUrl: (t) => chalk.dim(t),
  code: (t) => chalk.cyan(t),
  codeBlock: (t) => t,
  codeBlockBorder: (t) => chalk.dim(t),
  quote: (t) => chalk.dim.italic(t),
  quoteBorder: (t) => chalk.dim(t),
  hr: (t) => chalk.dim(t),
  listBullet: (t) => chalk.cyan(t),
  bold: (t) => chalk.bold(t),
  italic: (t) => chalk.italic(t),
  strikethrough: (t) => chalk.strikethrough(t),
  underline: (t) => chalk.underline(t),
};

export const editorTheme: EditorTheme = {
  borderColor: (t) => chalk.dim(t),
  selectList: {
    selectedPrefix: (t) => chalk.cyan(t),
    selectedText: (t) => chalk.bold(t),
    description: (t) => chalk.dim(t),
    scrollInfo: (t) => chalk.dim(t),
    noMatch: (t) => chalk.dim(t),
  },
};

export const loaderColors = {
  spinner: (t: string) => chalk.cyan(t),
  message: (t: string) => chalk.dim(t),
};
