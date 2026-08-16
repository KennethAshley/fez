import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

/**
 * Workflow definitions — Buzz's WorkflowDef (buzz-workflow/schema.rs),
 * fez-shaped and file-based: one YAML per workflow in ~/.fez/workflows
 * (or FEZ_WORKFLOWS_DIR), loaded at service start. Deliberately small
 * v1 vocabulary — message/reaction triggers, say + wait_reaction steps;
 * conditions, cron, and webhooks are Buzz features this can grow into.
 */

export interface TriggerDef {
  /** What fires the workflow. */
  on: "message" | "reaction";
  /**
   * Who may fire it: an agent name (resolved via 47000 metadata),
   * "owner" (FEZ_AGENT_OWNER), or a pubkey hex. Absent = any channel
   * member — membership is always required; strangers never trigger
   * automations.
   */
  from?: string;
  /** message triggers: case-insensitive regex the content must match. */
  filter?: string;
  /** reaction triggers: only this emoji fires (absent = any). */
  emoji?: string;
}

export interface SayStep {
  /**
   * Publish a channel message into the trigger's thread. Template vars:
   * {{trigger.text}}, {{trigger.author}}, {{trigger.author_name}},
   * {{trigger.id}}. @names are p-tagged via the 47000 roster, so this
   * is also how a workflow summons an agent.
   */
  say: string;
}

export interface WaitReactionStep {
  /**
   * Suspend the run until the previous step's message (or the trigger,
   * if first) receives a matching reaction — Buzz's RequestApproval
   * with reactions as the approval primitive.
   */
  wait_reaction: {
    /** Emoji that approves. Default 👍. */
    emoji?: string;
    /** Who may approve: "owner" (default), "any" (any member), an agent name, or a pubkey hex. */
    from?: string;
    /** Duration like "30s", "5m", "24h", "2d". Default 24h. */
    timeout?: string;
  };
}

export type StepDef = SayStep | WaitReactionStep;

export interface WorkflowDef {
  name: string;
  /** Channel name or id this workflow watches (a name matching several channels applies to all). */
  channel: string;
  trigger: TriggerDef;
  steps: StepDef[];
}

export function isSay(step: StepDef): step is SayStep {
  return typeof (step as SayStep).say === "string";
}

/** "30s" | "5m" | "24h" | "2d" -> milliseconds. */
export function parseDuration(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const match = raw.trim().match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) throw new Error(`bad duration "${raw}" (use e.g. 30s, 5m, 24h, 2d)`);
  const n = Number(match[1]);
  return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
}

/** Resolve {{trigger.X}} template variables. Unknown vars are left as-is (visible > silent). */
export function resolveTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
}

function validate(def: unknown, file: string): WorkflowDef {
  const d = def as Partial<WorkflowDef>;
  const fail = (msg: string): never => {
    throw new Error(`${file}: ${msg}`);
  };
  if (!d || typeof d !== "object") fail("not a mapping");
  if (!d.name || typeof d.name !== "string") fail(`"name" is required`);
  if (!d.channel || typeof d.channel !== "string") fail(`"channel" is required`);
  if (!d.trigger || typeof d.trigger !== "object") fail(`"trigger" is required`);
  if (d.trigger!.on !== "message" && d.trigger!.on !== "reaction") fail(`trigger.on must be "message" or "reaction"`);
  if (d.trigger!.filter) new RegExp(d.trigger!.filter); // throws on bad regex
  if (!Array.isArray(d.steps) || d.steps.length === 0) fail(`at least one step is required`);
  for (const [i, step] of d.steps!.entries()) {
    const s = step as Partial<SayStep & WaitReactionStep>;
    if (typeof s.say === "string") {
      if (!s.say.trim()) fail(`step ${i + 1}: "say" must not be empty`);
    } else if (s.wait_reaction && typeof s.wait_reaction === "object") {
      parseDuration(s.wait_reaction.timeout, 0); // throws on bad duration
    } else {
      fail(`step ${i + 1}: must be a "say" or "wait_reaction" step`);
    }
  }
  return d as WorkflowDef;
}

/** Load and validate every *.yaml / *.yml in the directory. Throws on any invalid definition. */
export function loadDefs(dir: string): WorkflowDef[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const defs: WorkflowDef[] = [];
  const seen = new Set<string>();
  for (const entry of entries.filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const def = validate(yaml.load(fs.readFileSync(path.join(dir, entry), "utf-8")), entry);
    if (seen.has(def.name)) throw new Error(`${entry}: duplicate workflow name "${def.name}"`);
    seen.add(def.name);
    defs.push(def);
  }
  return defs;
}
