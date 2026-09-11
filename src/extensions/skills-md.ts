import fs from "fs";
import path from "path";
import { fezHome } from "../shared/fez-home.js";

export interface InstalledSkill {
  pkg: string;
  id: string;
  name: string;
  description: string;
  /** Declared setting choices (`options: [lite, full, ultra]` frontmatter) — pickers render a dropdown when present. */
  options?: string[];
  path: string;
  /** Installed package boundary, used again when loading after discovery. */
  root?: string;
  disableModelInvocation?: boolean;
}

/** A bounded YAML frontmatter subset; instruction bytes are never rewritten. */
export function parseSkillMd(raw: string, stem: string): { name: string; description: string; options?: string[]; disableModelInvocation?: boolean; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { name: stem, description: "", body: raw.trim() };
  const lines = match[1].split(/\r?\n/);
  let name = stem, description = "";
  let options: string[] | undefined;
  let disableModelInvocation: boolean | undefined;
  const display = (value: string) => scalar(value).replace(/\s+/g, " ").trim();
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    const block: string[] = [];
    while (i + 1 < lines.length && /^(?:\s+.*|\s*)$/.test(lines[i + 1])) block.push(lines[++i].trim());
    if (key === "name" || key === "description") {
      const parsed = /^[|>][+-]?(?:\s+#.*)?$/.test(value) ? block.join(" ").trim() : display(value);
      if (key === "name") name = parsed || stem;
      else description = parsed;
    } else if (key === "options") {
      const values = value.trim() ? splitOptions(value) : block.filter(line => /^-\s+/.test(line)).map(line => line.replace(/^-\s+/, ""));
      const parsed = values.map(display).filter(Boolean);
      if (parsed.length) options = parsed;
    } else if (key === "disable-model-invocation") {
      // An unsupported or duplicate value must never turn manual-only into automatic.
      disableModelInvocation = disableModelInvocation === true || display(value).toLowerCase() !== "false";
    }
  }
  return { name, description, ...(options ? { options } : {}), ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}), body: match[2].trim() };
}

function scalar(value: string): string {
  value = value.trim();
  if (value.startsWith("'")) {
    const m = value.match(/^'((?:[^']|'')*)'(?:\s+#.*)?$/);
    if (m) return m[1].replace(/''/g, "'");
  }
  if (value.startsWith('"')) {
    const m = value.match(/^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/);
    if (m) { try { return JSON.parse(m[1]) as string; } catch { /* unsupported escape: retain literal */ } }
  }
  return value.replace(/\s+#.*$/, "");
}

function splitOptions(value: string): string[] {
  value = value.trim().replace(/^\[|\](?:\s+#.*)?$/g, "");
  const values: string[] = [];
  let start = 0, quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (quote === "'" && c === "'" && value[i + 1] === "'") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === ",") { values.push(value.slice(start, i)); start = i + 1; }
  }
  values.push(value.slice(start));
  return values;
}

/** Reject symlinks at every component within a package, including its root. */
export function safeSkillPath(root: string, relative: string): boolean {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return false;
  try {
    let current = path.resolve(root);
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) return false;
    for (const part of relative.split(/[\\/]/).filter(part => part && part !== ".")) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    return true;
  } catch { return false; }
}

/** Complete regular-file tree; shared by installation and discovery so support links are rejected too. */
export function skillResourceFiles(root: string, relative: string): string[] {
  const files: string[] = [];
  const collect = (rel: string, depth: number): void => {
    if (depth > 64 || !safeSkillPath(root, rel)) throw new Error(`unsafe skill path or symlink: ${rel}`);
    const file = path.join(root, rel);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file).sort()) collect(path.join(rel, child), depth + 1);
    } else if (stat.isFile()) files.push(rel);
    else throw new Error(`unsafe non-file skill resource: ${rel}`);
  };
  collect(relative, 0);
  return files;
}

/** Include the installed base directory so relative support-file references keep their meaning. */
export function readSkillInstructions(file: string, setting?: string, root = path.dirname(file), manualActivation = false): string {
  if (!path.isAbsolute(file) || !safeSkillPath(root, path.relative(root, file)) || !fs.lstatSync(file).isFile()) {
    throw new Error("Skill file is missing or escapes its installed package");
  }
  const body = fs.readFileSync(file, "utf8");
  if (!manualActivation && parseSkillMd(body, path.basename(file, ".md")).disableModelInvocation) throw new Error("Skill requires manual owner activation");
  return `[Skill instructions]\nBase directory: ${path.dirname(file)}\nResolve relative scripts, references, and assets from this directory.\n\n${body}${setting ? `\n\n[Attached setting: ${setting}]` : ""}`;
}

/**
 * Walk `<home>/packages/` for each package's `package.json`, and for one
 * that declares `fez.skills`, find SKILL.md directories and legacy root
 * markdown. Stop beneath a skill so resources are not new skills. Mirrors Rust's
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
    if (!safeSkillPath(pkgDir, "package.json")) continue;
    let manifest: { fez?: { skills?: { dir?: string } } };
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
    } catch {
      continue;
    }
    if (!manifest.fez?.skills) continue;
    const dir = manifest.fez.skills.dir ?? "skills";
    // A manifest-declared dir is attacker-controlled (installed verbatim,
    // never re-validated) — same escape gate materializeIntoPackage
    // enforces at write time, required again here since this is a
    // separate read path a package.json could still be hand-edited to hit.
    if (typeof dir !== "string" || /[\\\p{Cc}]/u.test(dir) || dir.split("/").some(part => !part || part === "." || part === "..")) {
      console.warn(`⚠ skill package "${pkgName}" declares an escaping dir "${dir}" — skipped`);
      continue;
    }
    if (!safeSkillPath(pkgDir, dir)) continue;
    try { skillResourceFiles(pkgDir, dir); } catch { continue; }
    const visit = (relative: string, top = false): void => {
      if (!safeSkillPath(pkgDir, relative)) return;
      const absolute = path.join(pkgDir, relative);
      if (!fs.lstatSync(absolute).isDirectory()) return;
      const entrypoint = path.join(relative, "SKILL.md");
      const skillRoot = safeSkillPath(pkgDir, entrypoint) && fs.lstatSync(path.join(pkgDir, entrypoint)).isFile();
      const files = skillRoot ? ["SKILL.md"] : fs.readdirSync(absolute).sort();
      for (const file of files) {
        const rel = path.join(relative, file);
        if (!safeSkillPath(pkgDir, rel)) continue;
        const filePath = path.join(pkgDir, rel);
        if (fs.lstatSync(filePath).isDirectory()) { if (!skillRoot) visit(rel); continue; }
        if (!fs.lstatSync(filePath).isFile() || !(skillRoot || (top && file.endsWith(".md")))) continue;
        const id = skillRoot ? (path.relative(path.join(pkgDir, dir), absolute).split(path.sep).join("/") || path.basename(absolute)) : path.basename(file, ".md");
        const { name, description, options, disableModelInvocation } = parseSkillMd(fs.readFileSync(filePath, "utf8"), id);
        if (!description) continue;
        found.push({ pkg: pkgName, id, name, description, options, path: filePath, root: pkgDir, ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}) });
      }
    };
    visit(dir, true);
  }
  return found;
}
