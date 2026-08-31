import { readFileSync } from "node:fs";

/** Parse FEZ_AGENT_SKILLS; bad/missing json -> {} */
export function attachedSkills(envJson: string | undefined): Record<string, string> {
  if (!envJson) return {};
  try {
    const parsed = JSON.parse(envJson);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore parse error
  }
  return {};
}

/** Body of an attached skill, or an Error naming the attached set. */
export function loadSkillBody(name: string, attached: Record<string, string>): string {
  const path = attached[name];
  if (!path) {
    const available = Object.keys(attached).join(", ") || "none";
    throw new Error(`unknown skill "${name}" — attached: ${available}`);
  }
  return readFileSync(path, "utf-8");
}
