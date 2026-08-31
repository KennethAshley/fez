import { fezHome, fezHomeAt } from "../shared/fez-home.js";
import fs from "fs/promises";
import path from "path";
import { notice } from "../cli/notices.js";
import { parseSkillSource, safeSkillName, safeSkillSource, SOURCE_SCHEMES } from "../extensions/skill-source.js";

/**
 * A named agent identity a user has configured — references a harness
 * (which binary/protocol implements it) plus its own name and system
 * prompt. Multiple personas can reference the same harness: "researcher"
 * and "reviewer" can both run on claude-code with different prompts.
 *
 * Stored as ~/.fez/personas/<id>.md — frontmatter + body, the same shape
 * as Claude Code's own subagents and pi's skills. A user can hand-write
 * one in an editor; `fez persona create` is just a convenience that writes
 * the same file. One source of truth, not a CLI-only registry.
 *
 * ---
 * harness: claude-code
 * aliases: [research]
 * mcpServers: [web-search=npm:@brave/brave-search-mcp-server, obsidian]
 * ---
 * You are a research assistant.
 *
 * mcpServers names resolved skills (see mcp-servers.ts) this persona's
 * sessions get access to — e.g. @researcher declares [web-search],
 * @reviewer declares [obsidian]. Fez resolves each name against whatever's
 * registered (built in or via an extension) when routing to this persona;
 * an unresolved name is dropped with a warning, not a hard failure.
 *
 * An entry may carry a SOURCE after `=` — `web-search=npm:<pkg>` — which
 * says where that name comes from, so the skill is installable in one
 * click on a machine that doesn't have it, and the persona is portable.
 * The name alone still resolves against local settings first; see
 * skill-source.ts for why a bare name deliberately resolves to nothing.
 */
export interface Persona {
  id: string;
  aliases: string[];
  /** HarnessAdapter.id this persona runs on, e.g. "claude-code". */
  harness: string;
  systemPrompt?: string;
  /** Names looked up in the mcp-servers.ts registry — see the interface doc above. */
  mcpServers: string[];
  /**
   * name → source spec, for the entries that declared one (`npm:<pkg>`,
   * `uvx:<pkg>`, `https://…`). Kept apart from `mcpServers` so every
   * existing consumer keeps seeing plain names: a source is what makes a
   * missing skill installable, never what makes it run.
   */
  mcpSources: Record<string, string>;
  /** SKILL.md packs this persona attaches — see the skills-standard spec. */
  skills: string[];
  /** name → source spec for the `skills` entries that declared one — same shape as mcpSources. */
  skillSources: Record<string, string>;
  /** name → per-attachment setting from `name(setting)` — free text the loaded skill interprets (e.g. ponytail's ultra). */
  skillSettings: Record<string, string>;
  /**
   * One-line self-description published in the agent's 47000 metadata —
   * what orchestrators route on. Write it as verb phrases ("search the
   * web, find papers, look up github repos"): small router models match
   * request verbs against description verbs, and noun-style bios
   * ("You are a research assistant.") measurably misroute on them.
   * Falls back to the system prompt's first line when absent.
   */
  description?: string;
  /**
   * Frontmatter keys this loader doesn't recognize, passed through
   * verbatim — the seam that lets a persona file configure whatever
   * service runs it (the orchestrator reads url/model/channels from
   * here) without core learning every service's vocabulary. Bracket
   * lists stay raw strings; consumers parse what they own.
   */
  extra: Record<string, string>;
  createdAt: string;
}

const PERSONAS_DIR = fezHome("personas");

/** ~/.fez/personas/<id>.md — `base` overrides the home root for tests. */
export function personaPath(id: string, base?: string): string {
  return fezHomeAt(base, "personas", `${id}.md`);
}

/** Shared by both bracket-list frontmatter fields (aliases, mcpServers) — `[a, b]` -> ["a", "b"]. */
function parseList(raw: string): string[] {
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `[web-search=npm:@brave/x, github]` -> names + the sources declared for
 * them. Split on the FIRST `=` only: a spec is itself full of colons and
 * slashes, and `npm:@scope/pkg` must survive intact.
 */
export function parseSkillEntries(entries: string[]): { names: string[]; sources: Record<string, string> } {
  const names: string[] = [];
  const sources: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const name = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    if (!name) continue;
    names.push(name);
    const source = eq === -1 ? "" : entry.slice(eq + 1).trim();
    if (source) sources[name] = source;
  }
  return { names, sources };
}

/**
 * The skills: line's richer grammar — `ponytail(ultra)=git:…` is a name,
 * an optional per-attachment setting in parens, and an optional source.
 * The setting is free text the loaded skill interprets (ponytail's own
 * body defines lite|full|ultra); fez only carries it. MIRRORED in
 * packages/fez-client/src/skill-source.ts — change both.
 */
export function parseSkillDecls(entries: string[]): { names: string[]; sources: Record<string, string>; settings: Record<string, string> } {
  const names: string[] = [];
  const sources: Record<string, string> = {};
  const settings: Record<string, string> = {};
  for (const entry of entries) {
    // The source split honors parens: `review(k=v)=npm:@x/y` splits at the
    // SECOND `=` — the first is inside the setting.
    let eq = -1;
    let depth = 0;
    for (let i = 0; i < entry.length; i++) {
      const c = entry[i];
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (c === "=" && depth === 0) { eq = i; break; }
    }
    const left = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    const source = eq === -1 ? "" : entry.slice(eq + 1).trim();
    const m = /^(.*?)\((.*)\)$/.exec(left);
    const name = (m ? m[1] : left).trim();
    if (!name) continue;
    names.push(name);
    if (m && m[2].trim()) settings[name] = m[2].trim();
    if (source) sources[name] = source;
  }
  return { names, sources, settings };
}

/** Inverse of parseSkillDecls — one entry per name, setting and source riding along. */
export function formatSkillDecls(names: string[], sources: Record<string, string>, settings: Record<string, string>): string {
  return names
    .map((n) => `${n}${settings[n] ? `(${settings[n]})` : ""}${sources[n] ? `=${sources[n]}` : ""}`)
    .join(", ");
}

/** Deliberately minimal — this frontmatter only ever needs a few flat fields, a real YAML parser would be overkill. */
export function parseFrontmatter(raw: string): { harness?: string; aliases: string[]; mcpServers: string[]; mcpSources: Record<string, string>; skills: string[]; skillSources: Record<string, string>; skillSettings: Record<string, string>; description?: string; extra: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { aliases: [], mcpServers: [], mcpSources: {}, skills: [], skillSources: {}, skillSettings: {}, extra: {}, body: raw.trim() };

  const [, frontmatter, body] = match;
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }

  const known = new Set(["harness", "aliases", "mcpServers", "skills", "description"]);
  const extra = Object.fromEntries(Object.entries(meta).filter(([k]) => !known.has(k)));

  const skills = parseSkillEntries(meta.mcpServers ? parseList(meta.mcpServers) : []);
  // NOTE: a setting is free text without commas or parens — parseList
  // splits on "," before parseSkillDecls ever sees the entry.
  const skillMds = parseSkillDecls(meta.skills ? parseList(meta.skills) : []);

  return {
    harness: meta.harness || undefined,
    aliases: meta.aliases ? parseList(meta.aliases) : [],
    mcpServers: skills.names,
    mcpSources: skills.sources,
    skills: skillMds.names,
    skillSources: skillMds.sources,
    skillSettings: skillMds.settings,
    description: meta.description || undefined,
    extra,
    body: body.trim(),
  };
}

/**
 * Render a persona file. `aliases:` and `mcpServers:` are each ONE
 * frontmatter line built out of `,` and `]`, so an entry carrying that
 * structure (or a newline) would write real keys into the file — the
 * injection fez-desktop's skill-attach refuses with the same rules
 * (safeSkillName/safeSkillSource in skill-source.ts). Throwing beats
 * filtering: a caller that asked for an entry we will not write should
 * hear so, not get a persona quietly missing a skill.
 */
export function serializePersona(harness: string, aliases: string[], mcpServers: string[], systemPrompt: string, skills: string[] = []): string {
  for (const entry of [...mcpServers, ...skills]) {
    const eq = entry.indexOf("=");
    const name = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    const source = eq === -1 ? "" : entry.slice(eq + 1).trim();
    if (!safeSkillName(name) || (source && !safeSkillSource(source))) {
      throw new Error(`unsafe skill entry refused: ${JSON.stringify(entry)}`);
    }
  }
  for (const alias of aliases) {
    if (/[\r\n\],]/.test(alias)) throw new Error(`unsafe alias refused: ${JSON.stringify(alias)}`);
  }
  const aliasLine = aliases.length > 0 ? `aliases: [${aliases.join(", ")}]\n` : "";
  const mcpServersLine = mcpServers.length > 0 ? `mcpServers: [${mcpServers.join(", ")}]\n` : "";
  const skillsLine = skills.length > 0 ? `skills: [${skills.join(", ")}]\n` : "";
  return `---\nharness: ${harness}\n${aliasLine}${mcpServersLine}${skillsLine}---\n${systemPrompt}\n`;
}

async function loadOne(filePath: string): Promise<Persona | undefined> {
  const id = path.basename(filePath, ".md");
  try {
    const [raw, stat] = await Promise.all([fs.readFile(filePath, "utf-8"), fs.stat(filePath)]);
    const { harness, aliases, mcpServers, mcpSources, skills, skillSources, skillSettings, description, extra, body } = parseFrontmatter(raw);
    if (!harness) {
      notice(`⚠️  ${id}.md has no "harness:" in its frontmatter — skipped`);
      return undefined;
    }
    return {
      id,
      aliases,
      harness,
      mcpServers,
      mcpSources,
      skills,
      skillSources,
      skillSettings,
      description,
      extra,
      systemPrompt: body || undefined,
      createdAt: stat.birthtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

/**
 * `extra` keys some fez consumer actually reads — the advisory whitelist
 * for validation (Buzz's error/warning split: unknown keys WARN, they
 * don't fail — extensions may own keys core doesn't know about, but a
 * typo'd `idleexit:` silently doing nothing is the bug class this catches).
 */
export const KNOWN_EXTRA_KEYS = new Set([
  "workdir", // fez-acp: per-persona working directory
  "repo", // fez-acp: work out of a CHECKOUT of this repo, not a scratch folder (needs a workspace provider)
  "branch", // fez-acp: pin to a branch; default is <agent>/work, one per agent so a fleet never races
  "scope", // fez-acp: sparse-checkout cone(s) — the agent's assignment, made physical
  "provider", // pi: defaultProvider
  "model", // pi: defaultModel
  "effort", // pi: defaultThinkingLevel (low|medium|high)
  "packages", // pi: registry packages
  "routable", // orchestrator: false = never delegated to by @fez (infrastructure, not a teammate)
  "idleExit", // fez-acp: self-exit after quiet period
  "idleTimeoutS", // fez-acp: turn idle deadline override
  "turnTimeoutS", // fez-acp: turn hard deadline override
  "url", // orchestrator: router endpoint
  "channels", // orchestrator/services: channel list
  "owner", // orchestrator/services: owner pubkey override
  "respondTo", // services: trigger policy
  "maxReplyChars", // fez-acp: hard cap on published reply length (bridge agents)
  "shareLevel", // fez-acp: bridge sharing policy — topics | summaries | detailed
  "approvalQuorum", // fez-mcp: N member ✅s approve a gate without the owner
]);

const MAX_BODY_BYTES = 256 * 1024; // Buzz's persona body bound
const MAX_FRONTMATTER_BYTES = 64 * 1024;

/** The frontmatter keys the parser reads directly, plus every extra key a fez consumer knows. */
const ALL_KNOWN_KEYS = ["harness", "aliases", "mcpServers", "skills", "description", ...KNOWN_EXTRA_KEYS];

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

/**
 * The known key an unknown one was probably reaching for, or undefined.
 *
 * Distance 2 catches the realistic typo (`mcpServer` → `mcpServers` is
 * 1) without claiming a match for a short custom key that happens to sit
 * near a known one — hence the length floor. Advisory only: the key is
 * still kept in `extra`, because extensions own keys fez has never heard
 * of and a rejection would break them.
 */
export function nearestKnownKey(key: string): string | undefined {
  if (key.length < 4) return undefined;
  let best: { key: string; distance: number } | undefined;
  for (const known of ALL_KNOWN_KEYS) {
    if (known === key) return undefined;
    const distance = editDistance(key.toLowerCase(), known.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { key: known, distance };
  }
  return best?.key;
}

export interface PersonaValidation {
  errors: string[];
  warnings: string[];
}

/**
 * Structural validation for a persona file — pure, so packs can validate
 * BEFORE installing and `fez persona validate` can lint what's on disk.
 * knownHarnesses (optional) enables the harness-exists check.
 */
export function validatePersonaFile(raw: string, id: string, knownHarnesses?: string[]): PersonaValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/^[\w-]+$/.test(id)) {
    errors.push(`persona id "${id}" — only letters, digits, _ and - (path safety)`);
  }
  const parsed = parseFrontmatter(raw);
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    errors.push("no frontmatter block (--- ... ---) — at minimum `harness:` is required");
    return { errors, warnings };
  }
  if (Buffer.byteLength(fmMatch[1]) > MAX_FRONTMATTER_BYTES) {
    errors.push(`frontmatter exceeds ${MAX_FRONTMATTER_BYTES / 1024}KB`);
  }
  if (Buffer.byteLength(parsed.body) > MAX_BODY_BYTES) {
    errors.push(`system prompt exceeds ${MAX_BODY_BYTES / 1024}KB`);
  }
  if (!parsed.harness) {
    errors.push(`"harness:" is required (e.g. harness: claude-code)`);
  } else if (knownHarnesses && !knownHarnesses.includes(parsed.harness)) {
    // A warning, not an error: extensions register harnesses too, and the
    // validator may run in a process that hasn't loaded them (the
    // orchestrator's "router" is the canonical case).
    warnings.push(`harness "${parsed.harness}" is not registered here (known: ${knownHarnesses.join(", ")}) — fine if an extension or service provides it`);
  }
  if (!parsed.description) {
    warnings.push(
      `no "description:" — orchestrators route on it; verb phrases ("search the web, find papers") route measurably better than nothing`
    );
  }
  if (!parsed.body.trim()) {
    warnings.push("empty system prompt — the persona will run on harness defaults alone");
  }
  for (const key of Object.keys(parsed.extra)) {
    if (!KNOWN_EXTRA_KEYS.has(key)) {
      const near = nearestKnownKey(key);
      warnings.push(
        near
          ? `unknown frontmatter key "${key}" — did you mean "${near}"? As written, nothing reads it.`
          : `unknown frontmatter key "${key}" — no fez consumer reads it (typo? extensions that own it can ignore this)`
      );
    }
  }
  // A source that doesn't parse is worse than no source: it LOOKS like
  // the skill is installable and silently isn't. Warn, don't fail —
  // schemes can grow, and a persona is still usable without the hint.
  for (const [name, source] of Object.entries(parsed.mcpSources)) {
    if (!parseSkillSource(source)) {
      warnings.push(
        `mcpServers "${name}=${source}" — not a source fez can resolve (${SOURCE_SCHEMES.join(", ")}); ` +
          `the name still works if the skill is defined locally`
      );
    }
  }
  return { errors, warnings };
}

/**
 * Merge pack-level defaults under a persona's frontmatter — the persona's
 * own keys always win (Buzz's pack merge policy). Textual: inserts
 * `key: value` lines before the closing --- for keys the file lacks.
 */
export function mergeDefaults(raw: string, defaults: Record<string, string>): string {
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/);
  if (!match) {
    const lines = Object.entries(defaults).map(([k, v]) => `${k}: ${v}`).join("\n");
    return `---\n${lines}\n---\n${raw}`;
  }
  const [, open, frontmatter, close, body] = match;
  const present = new Set(
    frontmatter.split(/\r?\n/).map((line) => line.match(/^([\w-]+):/)?.[1]).filter(Boolean)
  );
  const additions = Object.entries(defaults)
    .filter(([k]) => !present.has(k))
    .map(([k, v]) => `${k}: ${v}`);
  if (additions.length === 0) return raw;
  return `${open}${frontmatter}\n${additions.join("\n")}${close}${body}`;
}

export async function listPersonas(): Promise<Persona[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PERSONAS_DIR);
  } catch {
    return [];
  }

  const personas = await Promise.all(
    entries.filter((f) => f.endsWith(".md")).map((f) => loadOne(path.join(PERSONAS_DIR, f)))
  );
  return personas.filter((p): p is Persona => p !== undefined);
}

export async function findPersona(name: string): Promise<Persona | undefined> {
  const normalized = name.toLowerCase();

  // Fast path: filename matches directly, no need to scan/parse every file.
  // Falls through to the full scan below on a miss — covers both aliases
  // and a hand-created file whose name doesn't match its lowercase id
  // (e.g. on a case-sensitive filesystem).
  const direct = await loadOne(personaPath(normalized));
  if (direct) return direct;

  const personas = await listPersonas();
  return personas.find(
    (p) => p.id.toLowerCase() === normalized || p.aliases.some((a) => a.toLowerCase() === normalized)
  );
}

export async function createPersona(input: {
  id: string;
  harness: string;
  aliases?: string[];
  mcpServers?: string[];
  systemPrompt?: string;
}): Promise<Persona> {
  const filePath = personaPath(input.id.toLowerCase());

  try {
    await fs.access(filePath);
    throw new Error(`Persona "${input.id}" already exists`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Persona")) throw err;
    // else: file doesn't exist, proceed
  }

  await fs.mkdir(PERSONAS_DIR, { recursive: true });
  const aliases = input.aliases ?? [];
  const mcpServers = input.mcpServers ?? [];
  const systemPrompt = input.systemPrompt ?? "";
  await fs.writeFile(filePath, serializePersona(input.harness, aliases, mcpServers, systemPrompt), "utf-8");

  const persona = await loadOne(filePath);
  if (!persona) throw new Error(`Failed to write persona "${input.id}"`);
  return persona;
}

export async function removePersona(id: string): Promise<boolean> {
  try {
    await fs.unlink(personaPath(id.toLowerCase()));
    return true;
  } catch {
    return false;
  }
}
