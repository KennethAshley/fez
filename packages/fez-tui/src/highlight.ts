import chalk from "chalk";

/**
 * Minimal zero-dependency syntax highlighter for chat code blocks — wired
 * into pi-tui's MarkdownTheme.highlightCode hook. Deliberately not a real
 * lexer: a single alternating-regex pass per line (comment | string |
 * number | word) covering the constructs that dominate chat-sized snippets
 * across the common languages. One pass, left to right, so inserted ANSI
 * codes are never re-matched. Wrong-but-close coloring in exotic code is
 * an accepted tradeoff over pulling in highlight.js — fez-tui owns its
 * primitives.
 */

const KEYWORDS = new Set([
  // js/ts
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "class", "extends", "new", "import", "export", "from", "default", "async",
  "await", "try", "catch", "finally", "throw", "typeof", "interface", "type",
  "enum", "implements", "public", "private", "readonly", "static", "switch",
  "case", "break", "continue", "yield", "of", "in", "instanceof", "void",
  // python
  "def", "elif", "lambda", "pass", "raise", "with", "as", "assert", "del",
  "global", "nonlocal", "not", "and", "or", "is", "None", "True", "False",
  // rust/go/misc
  "fn", "impl", "struct", "trait", "match", "mut", "pub", "use", "mod",
  "func", "package", "go", "defer", "chan", "select", "nil",
  // shared literals
  "true", "false", "null", "undefined", "self", "this", "super",
]);

// Alternation order matters: comments swallow to end of line, strings
// before numbers/words so their contents are never re-tokenized.
const TOKEN_RE =
  /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\.?\d*\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/gm;

export function highlightCode(code: string, _lang?: string): string[] {
  return code.split("\n").map((line) =>
    line.replace(TOKEN_RE, (match, comment, str, num, word) => {
      if (comment !== undefined) return chalk.dim.italic(match);
      if (str !== undefined) return chalk.green(match);
      if (num !== undefined) return chalk.yellow(match);
      if (word !== undefined) return KEYWORDS.has(match) ? chalk.magenta(match) : match;
      return match;
    })
  );
}
