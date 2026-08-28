import { parseSkillEntries, formatSkillEntries } from "@fezchat/client";

/**
 * Editing the one frontmatter line that binds an agent to its skills.
 *
 * Pure and React-free so it can be tested directly (same arrangement as
 * onboarding-steps.ts). Every function returns `undefined` for "no
 * change needed, or this file isn't safe to edit" — callers skip the
 * write rather than round-tripping a file they'd only rewrite
 * identically, which is how unknown frontmatter keys and hand-written
 * formatting survive.
 *
 * Everything below builds the new file by slicing and concatenating
 * around one matched substring — never `String.prototype.replace(needle,
 * replacementString)`. That form honors `$&`/`$$`/`` $` ``/`$'` in the
 * replacement even when the needle is a plain string, so a skill name or
 * `source` containing `$&` would otherwise splice the whole matched line
 * into the file. `LINE` is also matched only inside the frontmatter
 * block (never the raw file), so a persona whose system-prompt body
 * happens to contain the literal text `mcpServers: [...]` is never
 * touched.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const LINE = /^mcpServers:\s*\[([^\]]*)\]/m;

/** This file's own newline convention, so an inserted line never mixes with it. */
function newlineOf(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function parseLine(content: string): { names: string[]; sources: Record<string, string> } {
  const fm = FRONTMATTER.exec(content);
  if (!fm) return { names: [], sources: {} };
  const line = LINE.exec(fm[0]);
  if (!line) return { names: [], sources: {} };
  return parseSkillEntries(line[1].split(",").map((s) => s.trim()).filter(Boolean));
}

/** What this persona declares, in order, with any recorded source. */
export function declaredSkills(content: string): { name: string; source?: string }[] {
  const { names, sources } = parseLine(content);
  return names.map((name) => ({ name, source: sources[name] }));
}

function writeLine(content: string, names: string[], sources: Record<string, string>): string | undefined {
  const fm = FRONTMATTER.exec(content);
  if (!fm) return undefined;
  const rendered = `mcpServers: [${formatSkillEntries(names, sources)}]`;
  const line = LINE.exec(fm[0]);

  if (line) {
    // Splice the rendered line into the frontmatter block only, then
    // stitch that back into the untouched rest of the file.
    const before = content.slice(0, fm.index) + fm[0].slice(0, line.index);
    const after = fm[0].slice(line.index + line[0].length) + content.slice(fm.index + fm[0].length);
    return before + rendered + after;
  }

  // No line yet — insert it as the last frontmatter key, using this
  // file's own newline convention, so the block stays a block, no
  // newline styles get mixed, and the body is never touched.
  const nl = newlineOf(content);
  const newBlock = `---${nl}${fm[1]}${nl}${rendered}${nl}---`;
  return content.slice(0, fm.index) + newBlock + content.slice(fm.index + fm[0].length);
}

/** Add a skill. `source` makes the persona portable; omit it for hand-rolled skills. */
export function attachSkill(content: string, skill: string, source?: string): string | undefined {
  if (!FRONTMATTER.test(content)) return undefined;
  const { names, sources } = parseLine(content);
  if (names.includes(skill)) return undefined;
  const next = [...names, skill];
  return writeLine(content, next, source ? { ...sources, [skill]: source } : sources);
}

/** Remove a skill, preserving every survivor's recorded source. */
export function detachSkill(content: string, skill: string): string | undefined {
  if (!FRONTMATTER.test(content)) return undefined;
  const { names, sources } = parseLine(content);
  if (!names.includes(skill)) return undefined;
  return writeLine(content, names.filter((n) => n !== skill), sources);
}
