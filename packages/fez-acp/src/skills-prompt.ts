import type { InstalledSkill } from "@fezchat/protocol";

/**
 * Attached skills at spawn — progressive disclosure only. The prompt gets
 * name+description (a menu); the body stays behind fez_load_skill until
 * the agent actually needs it, same reasoning as mcpServers resolution
 * next to this in agent.ts: declaring a skill isn't installing it, so the
 * gap between "persona declares" and "this machine has" is surfaced, not
 * papered over.
 */
export function resolveAttachedSkills(
  declared: string[],
  installed: InstalledSkill[]
): { attached: InstalledSkill[]; missing: string[] } {
  const attached: InstalledSkill[] = [];
  const missing: string[] = [];
  const byName = new Map<string, InstalledSkill>();
  for (const name of declared) {
    const match = installed.find((s) => s.id === name || s.name === name);
    if (!match) {
      missing.push(name);
      continue;
    }
    // skillsEnvJson/the prompt key by frontmatter `name` — two attached
    // skills sharing one would collapse in the env while both still list
    // in the prompt. Keep the first, warn about the one it shadows.
    const shadowing = byName.get(match.name);
    if (shadowing) {
      console.warn(`fez-acp: skill "${match.name}" from ${match.pkg} shadowed by ${shadowing.pkg} — attach names must be unique`);
      continue;
    }
    byName.set(match.name, match);
    attached.push(match);
  }
  return { attached, missing };
}

/** The `[Skills]` prompt section, or undefined when none attached. Never includes a body. */
export function skillsPromptSection(attached: InstalledSkill[]): string | undefined {
  if (attached.length === 0) return undefined;
  return [
    `[Skills]`,
    `You have these skills — load one with fez_load_skill when its description matches the task; follow a loaded skill until done.`,
    ...attached.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

/** JSON for FEZ_AGENT_SKILLS: {"<name>": "<abs path>"} */
export function skillsEnvJson(attached: InstalledSkill[]): string {
  return JSON.stringify(Object.fromEntries(attached.map((s) => [s.name, s.path])));
}
