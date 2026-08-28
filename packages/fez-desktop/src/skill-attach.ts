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
 */

const LINE = /^mcpServers:\s*\[([^\]]*)\]/m;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function parseLine(content: string): { names: string[]; sources: Record<string, string> } {
  const line = LINE.exec(content);
  if (!line) return { names: [], sources: {} };
  return parseSkillEntries(line[1].split(",").map((s) => s.trim()).filter(Boolean));
}

/** What this persona declares, in order, with any recorded source. */
export function declaredSkills(content: string): { name: string; source?: string }[] {
  const { names, sources } = parseLine(content);
  return names.map((name) => ({ name, source: sources[name] }));
}

function writeLine(content: string, names: string[], sources: Record<string, string>): string | undefined {
  const rendered = `mcpServers: [${formatSkillEntries(names, sources)}]`;
  const line = LINE.exec(content);
  if (line) return content.replace(line[0], rendered);
  // No line yet — insert it as the last frontmatter key, so the block
  // stays a block and the body is never touched.
  const fm = FRONTMATTER.exec(content);
  if (!fm) return undefined;
  return content.replace(fm[0], `---\n${fm[1]}\n${rendered}\n---`);
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
  const { names, sources } = parseLine(content);
  if (!names.includes(skill)) return undefined;
  return writeLine(content, names.filter((n) => n !== skill), sources);
}
