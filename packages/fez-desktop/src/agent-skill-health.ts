import { machineLocalPath, resolveInstalledSkill, type SkillEntry } from "@fezchat/client";
import { declaredSkills } from "./skill-attach";

/**
 * The two ways an agent is quietly broken.
 *
 * `missing` — declares a skill that resolves to nothing here. It spawns
 * anyway and is told to disclose the gap, which no one sees until the
 * agent gives a worse answer than it should have.
 *
 * `local` — resolves to a command inside a working directory, so the
 * agent runs on exactly this computer. Hand that persona to anyone and
 * it arrives with dead references.
 */
export function agentSkillHealth(
  personaContent: string,
  catalog: Record<string, SkillEntry>
): { missing: string[]; local: string[] } {
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
  return { missing, local };
}
