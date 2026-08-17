import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Cron } from "croner";
import { evalCondition } from "./expr.js";

/**
 * Workflow definitions — Buzz's WorkflowDef (buzz-workflow/schema.rs),
 * fez-shaped and file-based: one YAML per workflow in ~/.fez/workflows
 * (or FEZ_WORKFLOWS_DIR), loaded at service start. Deliberately small
 * v1 vocabulary — message/reaction triggers, say + wait_reaction steps;
 * conditions, cron, and webhooks are Buzz features this can grow into.
 */

export interface TriggerDef {
  /** What fires the workflow. */
  on: "message" | "reaction" | "schedule";
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
  /**
   * schedule triggers: cron expression (5-field, or 6-field with
   * seconds; evaluated by croner in local time). Mutually exclusive
   * with `every`. Fires are best-effort like Buzz's: last-fired state
   * is in-memory, missed fires during downtime are not replayed.
   */
  cron?: string;
  /** schedule triggers: simple interval like "30m", "1h". Mutually exclusive with `cron`. Minimum 30s. */
  every?: string;
}

interface StepBase {
  /**
   * Optional condition (see expr.ts) — when false the step is SKIPPED,
   * not failed (Buzz's semantics), and the run continues. An expression
   * that errors (bad syntax, unknown variable) also skips the step,
   * loudly, with the reason in the trace.
   */
  if?: string;
  /**
   * Optional step id: later steps can reference this step's output as
   * {{steps.<id>.output}} (say → message id; webhook → response body,
   * truncated; react → the emoji; delay → "").
   */
  id?: string;
}

export interface SayStep extends StepBase {
  /**
   * Publish a channel message into the trigger's thread. Template vars:
   * {{trigger.text}}, {{trigger.author}}, {{trigger.author_name}},
   * {{trigger.id}}, {{now}}. @names are p-tagged via the 47000 roster,
   * so this is also how a workflow summons an agent.
   */
  say: string;
}

export interface WaitReactionStep extends StepBase {
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

export interface DelayStep extends StepBase {
  /** Pause the run: "30s", "5m", "2h". */
  delay: string;
}

export interface DmStep extends StepBase {
  /** Send an encrypted DM (templated) — to "owner", an agent name, or a pubkey. */
  dm: { to: string; message: string };
}

export interface ReactStep extends StepBase {
  /** React to the previous step's message (or the trigger). Default 👍. */
  react: { emoji?: string };
}

export interface WebhookStep extends StepBase {
  /**
   * Call an external URL. Ported with Buzz's SEC-006 exfiltration fence,
   * fez-shaped: definitions are owner-placed local files (authoring is
   * trusted), but the URL must be STATIC — no {{templates}} — so channel
   * text can never steer where data goes. The body may template. https
   * or localhost only.
   */
  webhook: { url: string; method?: "GET" | "POST"; body?: string; timeout?: string };
}

export type StepDef = SayStep | WaitReactionStep | DelayStep | DmStep | ReactStep | WebhookStep;

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
export function isWait(step: StepDef): step is WaitReactionStep {
  return typeof (step as WaitReactionStep).wait_reaction === "object" && (step as WaitReactionStep).wait_reaction !== null;
}
export function isDelay(step: StepDef): step is DelayStep {
  return typeof (step as DelayStep).delay === "string";
}
export function isDm(step: StepDef): step is DmStep {
  return typeof (step as DmStep).dm === "object" && (step as DmStep).dm !== null;
}
export function isReact(step: StepDef): step is ReactStep {
  return typeof (step as ReactStep).react === "object" && (step as ReactStep).react !== null;
}
export function isWebhook(step: StepDef): step is WebhookStep {
  return typeof (step as WebhookStep).webhook === "object" && (step as WebhookStep).webhook !== null;
}

/** "30s" | "5m" | "24h" | "2d" -> milliseconds. */
export function parseDuration(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const match = raw.trim().match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) throw new Error(`bad duration "${raw}" (use e.g. 30s, 5m, 24h, 2d)`);
  const n = Number(match[1]);
  return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
}

/** Resolve {{trigger.X}} / {{now}} template variables. Unknown vars are left as-is (visible > silent). */
export function resolveTemplate(text: string, vars: Record<string, string | number | boolean>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
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
  const on = d.trigger!.on;
  if (on !== "message" && on !== "reaction" && on !== "schedule") fail(`trigger.on must be "message", "reaction", or "schedule"`);
  if (d.trigger!.filter) new RegExp(d.trigger!.filter); // throws on bad regex
  if (on === "schedule") {
    const { cron, every } = d.trigger!;
    if (!cron === !every) fail(`schedule triggers need exactly one of "cron" or "every"`);
    if (cron) new Cron(cron, { paused: true }).stop(); // throws on bad pattern
    if (every && parseDuration(every, 0) < 30_000) fail(`"every" must be at least 30s`);
  } else if (d.trigger!.cron || d.trigger!.every) {
    fail(`"cron"/"every" only apply to schedule triggers`);
  }
  if (!Array.isArray(d.steps) || d.steps.length === 0) fail(`at least one step is required`);
  const stepIds = new Set<string>();
  for (const [i, step] of d.steps!.entries()) {
    const s = step as Partial<SayStep & WaitReactionStep & DelayStep & DmStep & ReactStep & WebhookStep>;
    if (typeof s.say === "string") {
      if (!s.say.trim()) fail(`step ${i + 1}: "say" must not be empty`);
    } else if (s.wait_reaction && typeof s.wait_reaction === "object") {
      parseDuration(s.wait_reaction.timeout, 0); // throws on bad duration
      if (on === "schedule" && i === 0) fail(`step 1: a schedule run has no trigger message to react to — put a "say" before the first wait_reaction`);
    } else if (typeof s.delay === "string") {
      if (parseDuration(s.delay, 0) <= 0) fail(`step ${i + 1}: "delay" must be a positive duration`);
    } else if (s.dm && typeof s.dm === "object") {
      if (!s.dm.to || !s.dm.message) fail(`step ${i + 1}: dm needs "to" and "message"`);
    } else if (s.react && typeof s.react === "object") {
      if (on === "schedule" && i === 0) fail(`step 1: a schedule run has no message to react to yet`);
    } else if (s.webhook && typeof s.webhook === "object") {
      const w = s.webhook;
      if (!w.url) fail(`step ${i + 1}: webhook needs "url"`);
      if (/\{\{/.test(w.url)) fail(`step ${i + 1}: webhook url must be static — no {{templates}} (exfiltration fence)`);
      if (!/^https:\/\//.test(w.url) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(w.url)) {
        fail(`step ${i + 1}: webhook url must be https:// (or localhost for dev)`);
      }
      if (w.method && w.method !== "GET" && w.method !== "POST") fail(`step ${i + 1}: webhook method must be GET or POST`);
      parseDuration(w.timeout, 0);
    } else {
      fail(`step ${i + 1}: must be a "say", "wait_reaction", "delay", "dm", "react", or "webhook" step`);
    }
    if (s.id !== undefined) {
      if (typeof s.id !== "string" || !/^[\w-]+$/.test(s.id)) fail(`step ${i + 1}: "id" must be alphanumeric/_/-`);
      if (stepIds.has(s.id)) fail(`step ${i + 1}: duplicate step id "${s.id}"`);
      stepIds.add(s.id);
    }
    if (s.if !== undefined) {
      if (typeof s.if !== "string" || !s.if.trim()) fail(`step ${i + 1}: "if" must be a non-empty expression`);
      try {
        // Parse-check against a representative variable set so typos in
        // syntax fail at load; unknown-variable errors stay a runtime
        // skip (schedule runs have fewer vars than message runs).
        evalCondition(s.if, { "trigger.text": "", "trigger.author": "", "trigger.author_name": "", "trigger.id": "", now: "" });
      } catch (err) {
        if (err instanceof Error && !err.message.startsWith("unknown variable")) fail(`step ${i + 1}: bad "if" expression — ${err.message}`);
      }
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
