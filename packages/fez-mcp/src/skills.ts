import { readSkillInstructions } from "@fezchat/protocol";

/** One attached skill: where its body lives, plus the persona's per-attachment setting. */
export interface AttachedSkillRef {
  path: string;
  setting?: string;
  root?: string;
}

/** Parse FEZ_AGENT_SKILLS; bad/missing json -> {}. Values are
 * `{path, setting?}` objects; the original bare-string form (a path) is
 * still accepted so a newer fez-mcp works under an older fez-acp. */
export function attachedSkills(envJson: string | undefined): Record<string, AttachedSkillRef> {
  if (!envJson) return {};
  try {
    const parsed = JSON.parse(envJson);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const out: Record<string, AttachedSkillRef> = {};
      for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[name] = { path: v };
        else if (typeof v === "object" && v !== null && typeof (v as { path?: unknown }).path === "string") {
          const ref = v as { path: string; setting?: unknown; root?: unknown };
          out[name] = { path: ref.path, setting: typeof ref.setting === "string" ? ref.setting : undefined, root: typeof ref.root === "string" ? ref.root : undefined };
        }
      }
      return out;
    }
  } catch {
    // ignore parse error
  }
  return {};
}

/** Body of an attached skill (setting appended so the loaded skill sees how
 * it was attached), or an Error naming the attached set. */
export function loadSkillBody(name: string, attached: Record<string, AttachedSkillRef>): string {
  const ref = attached[name];
  if (!ref) {
    const available = Object.keys(attached).join(", ") || "none";
    throw new Error(`unknown skill "${name}" — attached: ${available}`);
  }
  return readSkillInstructions(ref.path, ref.setting, ref.root);
}
