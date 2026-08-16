import chalk from "chalk";
import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";
import { highlightCode } from "./highlight.js";

/**
 * Fez's visual identity — one active theme, swappable at runtime.
 *
 * The exported helpers (markdownTheme, authorColor, timestamp, …) are
 * STABLE DELEGATES into the active theme: consumers keep the same
 * imports they always had, and a theme switch changes what those
 * helpers produce from the next render on. Theme packs are extensions
 * (api.registerTheme) shipping a Partial<FezTheme> merged over this
 * default — pi-atelier-style community packages, no core changes.
 *
 * Style functions are plain (s: string) => string. Packs bundled into
 * ~/.fez/extensions can't resolve chalk — raw ANSI escapes are the
 * expected currency there (see examples/themes/).
 */

export type StyleFn = (s: string) => string;

export interface FezTheme {
  name: string;
  /** Reserved identities: the user's own messages, and fez's brand color. */
  you: StyleFn;
  brand: StyleFn;
  /** Hash-picked per-author palette — same author, same color, everywhere. */
  authorPalette: StyleFn[];
  timestamp: StyleFn;
  /** System lines, footers, secondary text. */
  dim: StyleFn;
  /** Links, prompts, spinner — the interactive accent. */
  accent: StyleFn;
  error: StyleFn;
  /** The FEZ block banner. */
  banner: StyleFn;
  /** Background painted across the full-height sidebar pane. */
  sidebarBg: StyleFn;
  loader: { spinner: StyleFn; message: StyleFn };
  markdown: MarkdownTheme;
  editor: EditorTheme;
}

export const defaultTheme: FezTheme = {
  name: "fez",
  you: chalk.bold.blue,
  brand: chalk.bold.magenta,
  authorPalette: [chalk.bold.green, chalk.bold.yellow, chalk.bold.cyan, chalk.bold.red, chalk.bold.magentaBright, chalk.bold.greenBright, chalk.bold.cyanBright, chalk.bold.yellowBright],
  timestamp: chalk.dim,
  dim: chalk.dim,
  accent: chalk.cyan,
  error: chalk.red,
  banner: chalk.magenta,
  sidebarBg: (s) => chalk.bgAnsi256(236)(s),
  loader: { spinner: chalk.cyan, message: chalk.dim },
  markdown: {
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
  },
  editor: {
    borderColor: (t) => chalk.dim(t),
    selectList: {
      selectedPrefix: (t) => chalk.cyan(t),
      selectedText: (t) => chalk.bold(t),
      description: (t) => chalk.dim(t),
      scrollInfo: (t) => chalk.dim(t),
      noMatch: (t) => chalk.dim(t),
    },
  },
};

let active: FezTheme = defaultTheme;

/** Swap the active theme: a pack's Partial merged over the default (nested groups merge too). */
export function setActiveTheme(partial: Partial<FezTheme>): void {
  active = {
    ...defaultTheme,
    ...partial,
    loader: { ...defaultTheme.loader, ...(partial.loader ?? {}) },
    markdown: { ...defaultTheme.markdown, ...(partial.markdown ?? {}) },
    editor: {
      ...defaultTheme.editor,
      ...(partial.editor ?? {}),
      selectList: { ...defaultTheme.editor.selectList, ...(partial.editor?.selectList ?? {}) },
    },
  };
}

export function getActiveTheme(): FezTheme {
  return active;
}

// ── Stable delegates — the surface every component imports. ─────────────

export const markdownTheme: MarkdownTheme = {
  heading: (t) => active.markdown.heading?.(t) ?? t,
  link: (t) => active.markdown.link?.(t) ?? t,
  linkUrl: (t) => active.markdown.linkUrl?.(t) ?? t,
  code: (t) => active.markdown.code?.(t) ?? t,
  codeBlock: (t) => active.markdown.codeBlock?.(t) ?? t,
  codeBlockBorder: (t) => active.markdown.codeBlockBorder?.(t) ?? t,
  quote: (t) => active.markdown.quote?.(t) ?? t,
  quoteBorder: (t) => active.markdown.quoteBorder?.(t) ?? t,
  hr: (t) => active.markdown.hr?.(t) ?? t,
  listBullet: (t) => active.markdown.listBullet?.(t) ?? t,
  bold: (t) => active.markdown.bold?.(t) ?? t,
  italic: (t) => active.markdown.italic?.(t) ?? t,
  strikethrough: (t) => active.markdown.strikethrough?.(t) ?? t,
  underline: (t) => active.markdown.underline?.(t) ?? t,
  highlightCode: (code, lang) => (active.markdown.highlightCode ?? highlightCode)(code, lang),
};

/**
 * Stable per-author colors, Slack-style: hash the display name into the
 * active palette. "You" and fez itself get the reserved colors.
 */
export function authorColor(name: string): StyleFn {
  if (name === "You") return (s) => active.you(s);
  if (name.toLowerCase() === "fez") return (s) => active.brand(s);
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const palette = active.authorPalette.length > 0 ? active.authorPalette : defaultTheme.authorPalette;
  return palette[Math.abs(hash) % palette.length];
}

/** Dim HH:MM:SS stamp prefixing each message line (tg/IRC-style). */
export function timestamp(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return active.timestamp(`${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`);
}

export const editorTheme: EditorTheme = {
  borderColor: (t) => active.editor.borderColor?.(t) ?? t,
  selectList: {
    selectedPrefix: (t) => active.editor.selectList?.selectedPrefix?.(t) ?? t,
    selectedText: (t) => active.editor.selectList?.selectedText?.(t) ?? t,
    description: (t) => active.editor.selectList?.description?.(t) ?? t,
    scrollInfo: (t) => active.editor.selectList?.scrollInfo?.(t) ?? t,
    noMatch: (t) => active.editor.selectList?.noMatch?.(t) ?? t,
  },
};

export const loaderColors = {
  spinner: (t: string) => active.loader.spinner(t),
  message: (t: string) => active.loader.message(t),
};
