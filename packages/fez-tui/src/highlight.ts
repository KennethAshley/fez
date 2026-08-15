import { createEmphasize, common } from "emphasize";

/**
 * Syntax highlighting for chat code blocks — wired into pi-tui's
 * MarkdownTheme.highlightCode hook. Backed by emphasize (highlight.js
 * tokenization → ANSI, maintained in the unified ecosystem) with the
 * `common` language set (~35 languages, covers what shows up in chat).
 * This module's signature IS the primitive fez owns — the seam pi-tui
 * calls through — the tokenizer behind it is deliberately a quality
 * package, not hand-rolled. Falls back to plain text on unknown
 * languages or highlighter errors: code must always render.
 */
const emphasize = createEmphasize(common);

export function highlightCode(code: string, lang?: string): string[] {
  try {
    const result =
      lang && emphasize.listLanguages().includes(lang)
        ? emphasize.highlight(lang, code)
        : emphasize.highlightAuto(code);
    return result.value.split("\n");
  } catch {
    return code.split("\n");
  }
}
