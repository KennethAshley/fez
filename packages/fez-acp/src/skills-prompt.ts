import type { InstalledSkill } from "@fezchat/protocol";

/** An attached skill plus the persona's per-attachment setting, if any. */
export interface AttachedSkill extends InstalledSkill {
  /** From `skills: [name(setting)]` — free text the loaded skill interprets (e.g. ponytail's ultra). */
  setting?: string;
}

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
  installed: InstalledSkill[],
  settings: Record<string, string> = {}
): { attached: AttachedSkill[]; missing: string[] } {
  const attached: AttachedSkill[] = [];
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
    // The setting keys by whatever the persona declared (id or name).
    attached.push({ ...match, setting: settings[name] });
  }
  return { attached, missing };
}

/** The `[Skills]` prompt section, or undefined when none attached. Never includes a body. */
export function skillsPromptSection(attached: AttachedSkill[]): string | undefined {
  attached = attached.filter(skill => !skill.disableModelInvocation);
  if (attached.length === 0) return undefined;
  return [
    `[Skills]`,
    `You have these skills — load one with fez_load_skill when its description matches the task; follow a loaded skill until done.`,
    ...attached.map((s) => `- ${s.name}: ${s.description}${s.setting ? ` (attached with: ${s.setting})` : ""}`),
  ].join("\n");
}

/** JSON for FEZ_AGENT_SKILLS: {"<name>": {"path": "<abs path>", "setting"?: "<text>"}} — fez-mcp also accepts the older bare-string form. */
export function skillsEnvJson(attached: AttachedSkill[]): string {
  return JSON.stringify(
    Object.fromEntries(attached.filter(s => !s.disableModelInvocation).map((s) => [s.name, { path: s.path, ...(s.root ? { root: s.root } : {}), ...(s.setting ? { setting: s.setting } : {}) }]))
  );
}

/** Only current, authenticated owner input can opt a manual skill into a turn. */
export function manualSkillForInput(
  attached: AttachedSkill[],
  input: { content: string; author: string; owner: string | undefined; persona: string },
): AttachedSkill | undefined {
  if (!input.owner || input.author !== input.owner) return;
  let content = input.content.trimStart();
  const mention = `@${input.persona}`;
  if (content.startsWith(mention) && /^\s/.test(content.slice(mention.length))) content = content.slice(mention.length).trimStart();
  const command = content.match(/^\/(\S+)(?:\s|$)/);
  if (!command) return;
  const name = command[1] === "skill" ? content.slice(command[0].length).trimStart().split(/\s/)[0] : command[1];
  return attached.find(skill => skill.disableModelInvocation && (skill.id === name || skill.name === name));
}
