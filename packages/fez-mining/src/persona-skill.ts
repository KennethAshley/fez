/**
 * Idempotent frontmatter editors that opt a persona into (or out of) the
 * mining MCP skill by editing its `mcpServers: [...]` line. Deliberately a
 * minimal string edit — the persona frontmatter is flat and we touch one
 * field; a YAML lib would be overkill (see personas.ts's own note).
 */
const SKILL = "mining";

function editMcpServers(md: string, transform: (names: string[]) => string[]): string {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) return md; // no frontmatter — leave untouched
  const block = fm[1];
  const lines = block.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("mcpServers:"));
  const current = idx >= 0
    ? (lines[idx].match(/\[(.*)\]/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const next = transform(current);
  if (idx >= 0) {
    if (next.length === 0) lines.splice(idx, 1);
    else lines[idx] = `mcpServers: [${next.join(", ")}]`;
  } else if (next.length > 0) {
    // insert after harness: if present, else at top of block
    const hIdx = lines.findIndex((l) => l.startsWith("harness:"));
    lines.splice(hIdx >= 0 ? hIdx + 1 : 0, 0, `mcpServers: [${next.join(", ")}]`);
  }
  return md.replace(fm[0], `---\n${lines.join("\n")}\n---\n`);
}

export function ensureMiningSkill(md: string): string {
  return editMcpServers(md, (names) => (names.includes(SKILL) ? names : [...names, SKILL]));
}

export function removeMiningSkill(md: string): string {
  return editMcpServers(md, (names) => names.filter((n) => n !== SKILL));
}
