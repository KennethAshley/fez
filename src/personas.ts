import fs from "fs/promises";
import path from "path";
import os from "os";

/**
 * A named agent identity a user has configured — references a harness
 * (which binary/protocol implements it) plus its own name and system
 * prompt. Multiple personas can reference the same harness: "researcher"
 * and "reviewer" can both run on claude-code with different prompts.
 */
export interface Persona {
  id: string;
  aliases: string[];
  /** HarnessAdapter.id this persona runs on, e.g. "claude-code". */
  harness: string;
  systemPrompt?: string;
  createdAt: string;
}

const PERSONAS_FILE = path.join(os.homedir(), ".fez", "personas.json");

async function readAll(): Promise<Persona[]> {
  try {
    const content = await fs.readFile(PERSONAS_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function writeAll(personas: Persona[]): Promise<void> {
  await fs.mkdir(path.dirname(PERSONAS_FILE), { recursive: true });
  await fs.writeFile(PERSONAS_FILE, JSON.stringify(personas, null, 2), "utf-8");
}

export async function listPersonas(): Promise<Persona[]> {
  return readAll();
}

export async function findPersona(name: string): Promise<Persona | undefined> {
  const normalized = name.toLowerCase();
  const personas = await readAll();
  return personas.find(
    (p) => p.id.toLowerCase() === normalized || p.aliases.some((a) => a.toLowerCase() === normalized)
  );
}

export async function createPersona(input: {
  id: string;
  harness: string;
  aliases?: string[];
  systemPrompt?: string;
}): Promise<Persona> {
  const personas = await readAll();

  if (personas.some((p) => p.id.toLowerCase() === input.id.toLowerCase())) {
    throw new Error(`Persona "${input.id}" already exists`);
  }

  const persona: Persona = {
    id: input.id,
    aliases: input.aliases ?? [],
    harness: input.harness,
    systemPrompt: input.systemPrompt,
    createdAt: new Date().toISOString(),
  };

  personas.push(persona);
  await writeAll(personas);
  return persona;
}

export async function removePersona(id: string): Promise<boolean> {
  const personas = await readAll();
  const next = personas.filter((p) => p.id.toLowerCase() !== id.toLowerCase());
  if (next.length === personas.length) return false;
  await writeAll(next);
  return true;
}
