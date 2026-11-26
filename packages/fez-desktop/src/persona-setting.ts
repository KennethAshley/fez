/**
 * One declared setting in a persona's frontmatter, read or changed without
 * touching the rest of the file: personas are edited by hand, so a control
 * in the app changes exactly one line, never the prose.
 */

const lineFor = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, "m");

export function personaSetting(md: string, key: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(md)?.[1];
  return frontmatter === undefined ? undefined : lineFor(key).exec(frontmatter)?.[1].trim() || undefined;
}

/** Replace the line if present, append it if not, drop it when the value is
 * empty. The value is forced onto one line: frontmatter is line-based, and
 * pasted text with a newline would otherwise declare settings of its own. */
export function withPersonaSetting(md: string, key: string, value: string | undefined): string {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  const line = cleaned ? `${key}: ${cleaned}` : undefined;
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return line ? `---\n${line}\n---\n\n${md}` : md;
  let fm = m[1];
  if (lineFor(key).test(fm)) {
    fm = line ? fm.replace(lineFor(key), () => line) : fm.replace(new RegExp(`\\n?^${key}:.*$`, "m"), "");
  } else if (line) {
    fm = `${fm}\n${line}`;
  }
  return `${md.slice(0, m.index)}---\n${fm}\n---${md.slice(m.index + m[0].length)}`;
}
