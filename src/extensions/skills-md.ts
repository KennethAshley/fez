import fs from "fs";
import path from "path";
import { fezHome } from "../shared/fez-home.js";

export interface InstalledSkill {
  pkg: string;
  id: string;
  name: string;
  description: string;
  path: string;
}

/**
 * Parse a skill .md's `---` frontmatter by line prefix — same technique
 * personas.ts's parseFrontmatter and git_install.rs's split_frontmatter
 * use, no YAML dep needed for two flat fields. `name` defaults to the
 * file stem; an absent `description` is "".
 */
export function parseSkillMd(raw: string, stem: string): { name: string; description: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: stem, description: "", body: raw.trim() };
  const [, frontmatter, body] = match;
  let name = stem;
  let description = "";
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === "name") name = kv[2].trim();
    if (kv[1] === "description") description = kv[2].trim();
  }
  return { name, description, body: body.trim() };
}

/**
 * Walk `<home>/packages/` for each package's `package.json`, and for one
 * that declares `fez.skills`, read every `.md` in its skills dir's
 * frontmatter — the CLI-side discovery mirror of Rust's
 * `list_installed_skills`. Skills without a `description` are skipped
 * (required field — routing/listing needs it, and a blank one is a sign
 * the file was never meant as a skill). `home` defaults to the real
 * ~/.fez, matching how package-manager.ts resolves it.
 */
export function skillsInstalled(home: string = fezHome()): InstalledSkill[] {
  const packagesDir = path.join(home, "packages");
  let pkgNames: string[];
  try {
    pkgNames = fs.readdirSync(packagesDir);
  } catch {
    return [];
  }

  const found: InstalledSkill[] = [];
  for (const pkgName of pkgNames) {
    const pkgDir = path.join(packagesDir, pkgName);
    let manifest: { fez?: { skills?: { dir?: string } } };
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
    } catch {
      continue;
    }
    if (!manifest.fez?.skills) continue;
    const dir = manifest.fez.skills.dir ?? "skills";
    const skillsDir = path.join(pkgDir, dir);
    let files: string[];
    try {
      files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(skillsDir, file);
      const stem = path.basename(file, ".md");
      const raw = fs.readFileSync(filePath, "utf-8");
      const { name, description } = parseSkillMd(raw, stem);
      if (!description) {
        console.warn(`⚠ skill ${pkgName}/${dir}/${file} has no "description:" — skipped`);
        continue;
      }
      found.push({ pkg: pkgName, id: stem, name, description, path: filePath });
    }
  }
  return found;
}
