import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePersonaFile } from "./personas.js";

/**
 * Persona drafts — Buzz's draft-create decision, fez-shaped: an agent
 * (or anyone) can PROPOSE a teammate, but nothing joins the fleet until
 * the owner approves. Drafts live in ~/.fez/personas/drafts — outside
 * the live personas dir, so herdr/sentinel can never spawn one — and
 * the whole lifecycle is files + CLI: the GUI is one more surface over
 * it, never the requirement.
 */

const DRAFT_META_KEYS = new Set(["proposedBy", "proposedAt"]);

function draftsDir(base?: string): string {
  return path.join(base ?? os.homedir(), ".fez", "personas", "drafts");
}

function personaPath(id: string, base?: string): string {
  return path.join(base ?? os.homedir(), ".fez", "personas", `${id}.md`);
}

export function validDraftName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,31}$/.test(name);
}

export interface DraftInfo {
  id: string;
  proposedBy?: string;
  description?: string;
  proposedAt?: string;
}

export function writeDraft(id: string, content: string, base?: string): void {
  if (!validDraftName(id)) throw new Error("draft name must be 2-32 chars of a-z, 0-9, - (it becomes the @mention)");
  if (fs.existsSync(personaPath(id, base))) throw new Error(`a live persona named "${id}" already exists`);
  const draftPath = path.join(draftsDir(base), `${id}.md`);
  // A pending draft is someone's proposal awaiting review — a second
  // write must not silently replace it (found live: a dupe overwrote
  // the original and the WRONG content got approved).
  if (fs.existsSync(draftPath)) throw new Error(`a draft named "${id}" is already awaiting review`);
  fs.mkdirSync(draftsDir(base), { recursive: true });
  fs.writeFileSync(draftPath, content);
}

export function listDrafts(base?: string): DraftInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(draftsDir(base));
  } catch {
    return [];
  }
  const drafts: DraftInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    let proposedBy: string | undefined;
    let description: string | undefined;
    let proposedAt: string | undefined;
    try {
      const raw = fs.readFileSync(path.join(draftsDir(base), entry), "utf-8");
      proposedBy = raw.match(/^proposedBy:\s*(.+)$/m)?.[1]?.trim();
      proposedAt = raw.match(/^proposedAt:\s*(.+)$/m)?.[1]?.trim();
      description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    } catch {
      /* unreadable draft still listed by name */
    }
    drafts.push({ id, proposedBy, description, proposedAt });
  }
  return drafts.sort((a, b) => a.id.localeCompare(b.id));
}

export function readDraft(id: string, base?: string): string {
  if (!validDraftName(id)) throw new Error("bad draft name");
  return fs.readFileSync(path.join(draftsDir(base), `${id}.md`), "utf-8");
}

/**
 * Approve: validate like `fez persona validate`, strip the draft-meta
 * keys, install into the live personas dir. Refuses to clobber an
 * existing persona — approval creates, it never overwrites.
 */
export function approveDraft(id: string, knownHarnesses?: string[], base?: string): { warnings: string[] } {
  const raw = readDraft(id, base);
  const cleaned = raw
    .split(/\r?\n/)
    .filter((line) => {
      const key = line.match(/^([\w-]+):/)?.[1];
      return !(key && DRAFT_META_KEYS.has(key));
    })
    .join("\n");
  const { errors, warnings } = validatePersonaFile(cleaned, id, knownHarnesses);
  if (errors.length > 0) throw new Error(`draft "${id}" is invalid:\n  - ${errors.join("\n  - ")}`);
  const target = personaPath(id, base);
  if (fs.existsSync(target)) throw new Error(`a live persona named "${id}" already exists`);
  fs.writeFileSync(target, cleaned);
  fs.unlinkSync(path.join(draftsDir(base), `${id}.md`));
  return { warnings };
}

export function rejectDraft(id: string, base?: string): void {
  if (!validDraftName(id)) throw new Error("bad draft name");
  fs.unlinkSync(path.join(draftsDir(base), `${id}.md`));
}
