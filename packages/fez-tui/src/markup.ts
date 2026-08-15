import chalk from "chalk";

/**
 * Lightweight inline markup for chat replies — bold, inline code, and
 * fenced code blocks. Deliberately not a markdown parser (no headings,
 * lists, tables, links): chat replies mostly just need emphasis and code
 * to read cleanly, and a real parser is a much bigger dependency/surface
 * than that needs. See packages/fez-tui/README.md.
 */
export function renderMarkup(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      inCodeBlock = !inCodeBlock;
      out.push(chalk.dim(inCodeBlock ? `┌─ ${fence[1] || ""}`.trimEnd() : "└─"));
      continue;
    }
    if (inCodeBlock) {
      out.push(chalk.dim("│ ") + chalk.cyan(line));
      continue;
    }
    out.push(renderInline(line));
  }

  return out.join("\n");
}

function renderInline(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, (_, t: string) => chalk.bold(t))
    .replace(/`([^`]+)`/g, (_, t: string) => chalk.cyan(t));
}
