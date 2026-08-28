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

/**
 * The choke point for names that arrive from OFF THIS MACHINE.
 *
 * A relay listing's `name` is a stranger's string, and these functions
 * are the first thing on this branch that carries one into a PERSONA
 * file — previously it stopped at settings.json, where a strange key is
 * inert. Frontmatter is not inert: a name containing `]` and a newline
 * closes the `mcpServers: [...]` list and opens whatever key it likes.
 * The 22-character `x]<newline>aliases: [admin, ceo` passes a non-empty
 * length check, renders invisibly in HTML, and hands the persona two
 * more names to answer to. `respondTo:`, `owner:` and `workdir:` are
 * reachable the same way.
 *
 * So the SHAPE is allowed, not the escapes: npm's own name grammar plus
 * `@` and `/` for scoped names. No newline, no `]`, no `,`, no `=` —
 * the characters the line's own syntax is made of. A refusal returns
 * `undefined` like every other "not safe to edit" here, so the caller's
 * existing "unsafe" branch reports it instead of writing.
 */
const SAFE_NAME = /^[A-Za-z0-9._@/-]{1,64}$/;

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
  if (!SAFE_NAME.test(skill)) return undefined;
  if (!FRONTMATTER.test(content)) return undefined;
  const { names, sources } = parseLine(content);
  if (names.includes(skill)) return undefined;
  const next = [...names, skill];
  return writeLine(content, next, source ? { ...sources, [skill]: source } : sources);
}

/** Remove a skill, preserving every survivor's recorded source. */
export function detachSkill(content: string, skill: string): string | undefined {
  if (!SAFE_NAME.test(skill)) return undefined;
  if (!FRONTMATTER.test(content)) return undefined;
  const { names, sources } = parseLine(content);
  if (!names.includes(skill)) return undefined;
  return writeLine(content, names.filter((n) => n !== skill), sources);
}

/**
 * Record where an ALREADY-DECLARED skill comes from, turning
 * `mcpServers: [web-search]` into `[web-search=npm:@brave/…]`.
 *
 * Lives here rather than in SkillsView so there is exactly ONE persona
 * writer with these safety properties: frontmatter-scoped matching, a
 * literal splice instead of `String.replace(needle, replacement)` (which
 * honors `$&` in the replacement even for a plain-string needle, so a
 * url source containing `$&` would splice the matched line back into
 * the file), and the same name guard as attach/detach.
 *
 * Undefined means "nothing to write": no frontmatter, no such
 * declaration, or that source is already recorded.
 */
export function rememberSkillSource(content: string, skill: string, source: string): string | undefined {
  if (!SAFE_NAME.test(skill)) return undefined;
  if (!FRONTMATTER.test(content)) return undefined;
  const { names, sources } = parseLine(content);
  if (!names.includes(skill)) return undefined;
  if (sources[skill] === source) return undefined;
  return writeLine(content, names, { ...sources, [skill]: source });
}
