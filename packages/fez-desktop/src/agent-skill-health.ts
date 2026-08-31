import { machineLocalPath, resolveInstalledSkill, type SkillEntry } from "@fezchat/client";
import { declaredSkills } from "./skill-attach";

/** A `list_installed_skills` row — a SKILL.md pack, not a tool. Matched
 * by id or name, the same rule spawn-time resolution uses
 * (fez-acp/skills-prompt.ts's resolveAttachedSkills). */
export interface InstalledSkillMd {
  pkg: string;
  /** The pack's human name (git repo name, else the pkg) — what pickers label the pack with. */
  title?: string;
  id: string;
  name: string;
  description: string;
  /** Declared setting choices (`options:` frontmatter) — pickers render a dropdown when present. */
  options?: string[];
}

/**
 * The three ways an agent is quietly broken.
 *
 * `missing` — declares a TOOL (`mcpServers:`) that resolves to nothing
 * here. It spawns anyway and is told to disclose the gap, which no one
 * sees until the agent gives a worse answer than it should have.
 *
 * `local` — resolves to a command inside a working directory, so the
 * agent runs on exactly this computer. Hand that persona to anyone and
 * it arrives with dead references.
 *
 * `missingSkillMds` — declares a SKILL.md pack (`skills:`) not installed
 * here. Same gap as `missing`, different frontmatter line and catalog,
 * so it is tracked separately rather than folded in.
 */
export function agentSkillHealth(
  personaContent: string,
  catalog: Record<string, SkillEntry>,
  skillMds: InstalledSkillMd[] = []
): { missing: string[]; local: string[]; missingSkillMds: string[] } {
  const missing: string[] = [];
  const local: string[] = [];
  for (const declared of declaredSkills(personaContent)) {
    const hit = resolveInstalledSkill(catalog, declared);
    if (!hit) {
      missing.push(declared.name);
      continue;
    }
    if (machineLocalPath(hit.entry)) local.push(declared.name);
  }
  const missingSkillMds = declaredSkills(personaContent, "skills")
    .map((d) => d.name)
    .filter((name) => !skillMds.some((s) => s.id === name || s.name === name));
  return { missing, local, missingSkillMds };
}

/**
 * The same walk, kept in declaration order and flagged per skill —
 * what the roster's skill strip renders.
 *
 * `agentSkillHealth` answers "is this agent broken"; this answers "what
 * can this agent do, and which of those actually work here". They share
 * the walk deliberately: two readers of one persona that disagreed
 * about the same skill is the bug this branch spent a review round on.
 */
export function agentSkillStrip(
  personaContent: string,
  catalog: Record<string, SkillEntry>
): { name: string; missing?: boolean; local?: boolean }[] {
  return declaredSkills(personaContent).map((declared) => {
    const hit = resolveInstalledSkill(catalog, declared);
    if (!hit) return { name: declared.name, missing: true };
    if (machineLocalPath(hit.entry)) return { name: declared.name, local: true };
    return { name: declared.name };
  });
}
