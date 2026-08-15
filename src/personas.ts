import fs from "fs/promises";
import path from "path";
import os from "os";
import { notice } from "./notices.js";

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
 * mcpServers: [web-search]
 * ---
 * You are a research assistant.
 *
 * mcpServers names resolved skills (see mcp-servers.ts) this persona's
 * sessions get access to — e.g. @researcher declares [web-search],
 * @reviewer declares [obsidian]. Fez resolves each name against whatever's
 * registered (built in or via an extension) when routing to this persona;
 * an unresolved name is dropped with a warning, not a hard failure.
 */
export interface Persona {
  id: string;
  aliases: string[];
  /** HarnessAdapter.id this persona runs on, e.g. "claude-code". */
  harness: string;
  systemPrompt?: string;
  /** Names looked up in the mcp-servers.ts registry — see the interface doc above. */
  mcpServers: string[];
  createdAt: string;
}

const PERSONAS_DIR = path.join(os.homedir(), ".fez", "personas");

function personaPath(id: string): string {
  return path.join(PERSONAS_DIR, `${id}.md`);
}

/** Shared by both bracket-list frontmatter fields (aliases, mcpServers) — `[a, b]` -> ["a", "b"]. */
function parseList(raw: string): string[] {
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Deliberately minimal — this frontmatter only ever needs a few flat fields, a real YAML parser would be overkill. */
function parseFrontmatter(raw: string): { harness?: string; aliases: string[]; mcpServers: string[]; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { aliases: [], mcpServers: [], body: raw.trim() };

  const [, frontmatter, body] = match;
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }

  return {
    harness: meta.harness || undefined,
    aliases: meta.aliases ? parseList(meta.aliases) : [],
    mcpServers: meta.mcpServers ? parseList(meta.mcpServers) : [],
    body: body.trim(),
  };
}

function serialize(harness: string, aliases: string[], mcpServers: string[], systemPrompt: string): string {
  const aliasLine = aliases.length > 0 ? `aliases: [${aliases.join(", ")}]\n` : "";
  const mcpServersLine = mcpServers.length > 0 ? `mcpServers: [${mcpServers.join(", ")}]\n` : "";
  return `---\nharness: ${harness}\n${aliasLine}${mcpServersLine}---\n${systemPrompt}\n`;
}

async function loadOne(filePath: string): Promise<Persona | undefined> {
  const id = path.basename(filePath, ".md");
  try {
    const [raw, stat] = await Promise.all([fs.readFile(filePath, "utf-8"), fs.stat(filePath)]);
    const { harness, aliases, mcpServers, body } = parseFrontmatter(raw);
    if (!harness) {
      notice(`⚠️  ${id}.md has no "harness:" in its frontmatter — skipped`);
      return undefined;
    }
    return {
      id,
      aliases,
      harness,
      mcpServers,
      systemPrompt: body || undefined,
      createdAt: stat.birthtime.toISOString(),
    };
  } catch {
    return undefined;
  }
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
  await fs.writeFile(filePath, serialize(input.harness, aliases, mcpServers, systemPrompt), "utf-8");

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
