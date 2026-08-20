import type { RefObject } from "react";

/**
 * The markdown toolbar, and the text operations behind it.
 *
 * These lived inside Composer, which meant the channel had a format bar
 * and doc comments — the other place you write prose that other people
 * and agents read — had a bare textarea. Same authoring surface, two
 * different affordances, for no reason other than where the code sat.
 *
 * Everything here operates on a textarea's current selection and hands
 * the caret back where a writer expects it, which is the fiddly part and
 * exactly why it should exist once rather than twice.
 *
 * "WYSIWYG" is not quite what this is, and the distinction matters: the
 * buffer stays markdown, because markdown is what gets published, what
 * an agent reads, and what a doc is stored as. The toolbar writes the
 * marks for you and the preview renders them — but the text you edit is
 * always the text that ships. A true rich-text buffer would have to
 * round-trip through markdown on every keystroke and would lose exactly
 * the things docs rely on ([[wikilinks]], code fences, tables).
 */

export interface FormatOps {
  wrapSelection(mark: string): void;
  prefixLines(prefix: string | ((index: number) => string)): void;
  makeLink(): void;
  codeBlock(): void;
}

export function markdownFormatOps(
  areaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (next: string) => void,
  onSelectionSync?: (range: { start: number; end: number } | undefined) => void
): FormatOps {
  /** Toggle a paired mark around the selection — a second press removes it. */
  const wrapSelection = (mark: string) => {
    const area = areaRef.current;
    if (!area) return;
    const { selectionStart: start, selectionEnd: end } = area;
    if (start === end) return;
    const inner = value.slice(start, end);
    const already = value.slice(start - mark.length, start) === mark && value.slice(end, end + mark.length) === mark;
    const next = already
      ? value.slice(0, start - mark.length) + inner + value.slice(end + mark.length)
      : value.slice(0, start) + mark + inner + mark + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      area.focus();
      const delta = already ? -mark.length : mark.length;
      area.selectionStart = start + delta;
      area.selectionEnd = end + delta;
      onSelectionSync?.({ start: start + delta, end: end + delta });
    });
  };

  /** Prefix every line the selection touches (lists, quote) — Slack's toolbar ops in markdown. */
  const prefixLines = (prefix: string | ((index: number) => string)) => {
    const area = areaRef.current;
    if (!area) return;
    const { selectionStart: start, selectionEnd: end } = area;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = value.indexOf("\n", end);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const next = lines.map((line, index) => (typeof prefix === "string" ? prefix : prefix(index)) + line).join("\n");
    onChange(value.slice(0, lineStart) + next + value.slice(lineEnd));
    requestAnimationFrame(() => {
      area.focus();
      area.selectionStart = area.selectionEnd = lineStart + next.length;
    });
  };

  /** [selection](url) with "url" left selected for immediate typing. */
  const makeLink = () => {
    const area = areaRef.current;
    if (!area) return;
    const { selectionStart: start, selectionEnd: end } = area;
    const inner = value.slice(start, end) || "text";
    const next = `${value.slice(0, start)}[${inner}](url)${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      area.focus();
      area.selectionStart = start + inner.length + 3;
      area.selectionEnd = start + inner.length + 6;
    });
  };

  const codeBlock = () => {
    const area = areaRef.current;
    if (!area) return;
    const { selectionStart: start, selectionEnd: end } = area;
    const inner = value.slice(start, end);
    const next = `${value.slice(0, start)}\`\`\`\n${inner}\n\`\`\`${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      area.focus();
      area.selectionStart = area.selectionEnd = start + 4 + inner.length;
    });
  };

  return { wrapSelection, prefixLines, makeLink, codeBlock };
}

/** The buttons. `className` picks the always-open bar or the on-selection tray. */
export function FormatBar({ ops, className = "format-bar" }: { ops: FormatOps; className?: string }) {
  const hold = (run: () => void) => (e: React.MouseEvent) => {
    // mousedown + preventDefault, never onClick: clicking a button would
    // blur the textarea and collapse the selection being formatted.
    e.preventDefault();
    run();
  };
  return (
    <div className={className}>
      <button title="bold (⌘B)" onMouseDown={hold(() => ops.wrapSelection("**"))}><b>B</b></button>
      <button title="italic (⌘I)" onMouseDown={hold(() => ops.wrapSelection("*"))}><i>I</i></button>
      <button title="code (⌘E)" onMouseDown={hold(() => ops.wrapSelection("`"))}>{"</>"}</button>
      <button title="strikethrough" onMouseDown={hold(() => ops.wrapSelection("~~"))}><s>S</s></button>
      <span className="tray-sep" />
      <button title="link" className="emoji-glyph" onMouseDown={hold(() => ops.makeLink())}>🔗</button>
      <button title="bulleted list" onMouseDown={hold(() => ops.prefixLines("- "))}>≔</button>
      <button title="numbered list" onMouseDown={hold(() => ops.prefixLines((index) => `${index + 1}. `))}>⒈</button>
      <button title="quote" onMouseDown={hold(() => ops.prefixLines("> "))}>❝</button>
      <button title="code block" onMouseDown={hold(() => ops.codeBlock())}>▤</button>
    </div>
  );
}
