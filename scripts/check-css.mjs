#!/usr/bin/env node
/**
 * One rule: a selector is declared once.
 *
 * .rail was declared four times across 1,200 lines — the original box,
 * terminal chrome, the flex column that pins the self card, and the
 * resizable width. Each block was correct alone. Two of them disagreed
 * about `width`, source order decided, and the left rail silently
 * stopped resizing. Nothing in the drag code was wrong, so reading the
 * drag code found nothing; the ambiguity was invisible from inside any
 * single block.
 *
 * A linter would have failed the day the fourth block landed. This is
 * that linter, without the dependency — the desktop app deliberately
 * has no styling toolchain, and adding one to catch a single rule would
 * be a poor trade.
 *
 * Media queries are exempt: redeclaring a selector under @media is the
 * point of @media.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHEETS = [process.env.CHECK_CSS_FILE ?? join(ROOT, "packages/fez-desktop/src/App.css")];

let failed = false;

for (const sheet of SHEETS) {
  const text = readFileSync(sheet, "utf-8");
  const lines = text.split("\n");
  const seen = new Map(); // selector -> [line numbers]
  let depth = 0; // inside @media / @supports, where redeclaring is fine

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("@media") || trimmed.startsWith("@supports")) depth++;
    else if (depth > 0 && trimmed === "}") depth--;
    if (depth > 0) return;

    const match = /^([.#][^{}]*?)\s*\{\s*$|^([.#][^{}]*?)\s*\{.*\}\s*$/.exec(trimmed);
    if (!match) return;
    // Normalise ".a, .b" so a reordered list is still the same rule.
    const selector = (match[1] ?? match[2])
      .split(",")
      .map((part) => part.trim().replace(/\s+/g, " "))
      .sort()
      .join(", ");
    if (!seen.has(selector)) seen.set(selector, []);
    seen.get(selector).push(index + 1);
  });

  // Braces first: an orphaned declaration block — a selector deleted and
  // its body left behind — makes the parser drop rules from there on, and
  // the damage shows up somewhere unrelated. That happened: a regex took
  // out .env-grid-head's selector but not its declarations, and the whole
  // window painted accent-orange on hover, 700 lines away.
  let braceDepth = 0;
  lines.forEach((line, index) => {
    braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (braceDepth < 0) {
      failed = true;
      console.error(`\n✗ ${relative(ROOT, sheet)}:${index + 1} — unbalanced brace: a } with no block open.`);
      console.error("  Usually a selector was deleted and its declarations left behind.\n");
      braceDepth = 0;
    }
  });
  if (braceDepth !== 0) {
    failed = true;
    console.error(`\n✗ ${relative(ROOT, sheet)} — ${braceDepth} block(s) left unclosed at end of file.\n`);
  }

  const dupes = [...seen.entries()].filter(([, at]) => at.length > 1);
  const where = relative(ROOT, sheet);
  if (dupes.length === 0) {
    console.log(`✓ ${where} — ${seen.size} selectors, each declared once`);
    continue;
  }

  failed = true;
  console.error(`\n✗ ${where} — ${dupes.length} selectors declared more than once:\n`);
  for (const [selector, at] of dupes.sort((a, b) => b[1].length - a[1].length)) {
    console.error(`  ${String(at.length).padStart(2)}×  ${selector}`);
    console.error(`      lines ${at.join(", ")}`);
  }
  console.error(
    "\nMerge each into ONE block where the thing is defined. Two blocks for the\n" +
      "same selector means source order picks the winner, which is a coin flip\n" +
      "nobody reading either block can see.\n"
  );
}

process.exit(failed ? 1 : 0);
