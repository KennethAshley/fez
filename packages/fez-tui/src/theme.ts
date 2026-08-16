import chalk from "chalk";
import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";
import { highlightCode } from "./highlight.js";

/**
 * Fez's chalk-based themes for pi-tui components — the one place visual
 * identity lives, so tui.ts and any future component pull from here
 * instead of scattering chalk calls per call site. Derived from the
 * palette the original pi-tui proof used (git 9285628's demo.ts).
 *
 * (Future: a registerTheme extension point would let theme packs ship as
 * community npm packages, pi-atelier-style — this module becomes the
 * default they override.)
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
  highlightCode,
};

/**
 * Stable per-author colors, Slack-style: hash the display name into a
 * fixed palette so @researcher is always the same color everywhere.
 * "You" is reserved blue, "Fez" reserved magenta — the two identities
 * with fixed meaning.
 */
const AUTHOR_PALETTE = [chalk.bold.green, chalk.bold.yellow, chalk.bold.cyan, chalk.bold.red, chalk.bold.magentaBright, chalk.bold.greenBright, chalk.bold.cyanBright, chalk.bold.yellowBright];

export function authorColor(name: string): (s: string) => string {
  if (name === "You") return chalk.bold.blue;
  if (name === "Fez") return chalk.bold.magenta;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AUTHOR_PALETTE[Math.abs(hash) % AUTHOR_PALETTE.length];
}

/** Dim HH:MM:SS stamp prefixing each message line (tg/IRC-style). */
export function timestamp(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return chalk.dim(`${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`);
}

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
