import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PackageManager } from "../../../src/extensions/package-manager.js";
import { skillsInstalled } from "../../../src/extensions/skills-md.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(link = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-skill-install-"));
  temporary.push(dir);
  const source = path.join(dir, "bundle");
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(source, "skills", "category", "focus", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills", "category", "focus", "references", "nested"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills", "category", "focus", "assets"), { recursive: true });
  const raw = "---\nname: 'Focus'\ndescription: >-\n  One task\n  at a time.\ndisable-model-invocation: true\n---\nUse scripts/run.sh and references/guide.md.\n";
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "bundle", version: "1.0.0", private: true,
    scripts: { postinstall: "touch SHOULD_NOT_EXECUTE" }, fez: { type: "extension", skills: {} } }));
  fs.writeFileSync(path.join(source, ".npmrc"), "offline=true\naudit=false\nfund=false\n");
  fs.writeFileSync(path.join(source, "skills", "category", "focus", "SKILL.md"), raw);
  fs.writeFileSync(path.join(source, "skills", "category", "focus", "scripts", "run.sh"), "#!/bin/sh\ntouch SHOULD_NOT_EXECUTE\n", { mode: 0o755 });
  fs.writeFileSync(path.join(source, "skills", "category", "focus", "references", "guide.md"), "Reference bytes\n");
  fs.writeFileSync(path.join(source, "skills", "category", "focus", "references", "nested", "SKILL.md"), "---\ndescription: A reference, never a nested skill\n---\nReference\n");
  fs.writeFileSync(path.join(source, "skills", "category", "focus", "assets", "sample.bin"), Buffer.from([0, 128, 255]));
  fs.writeFileSync(path.join(source, "skills", "legacy.md"), "---\ndescription: Legacy\n---\nLegacy body\n");
  if (link) fs.symlinkSync("../../../../../../outside", path.join(source, "skills", "category", "focus", "scripts", "escape"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: source, stdio: "pipe" });
  git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture");
  const pm = new PackageManager({ base: home, settings: { load: () => ({}), save: () => undefined } });
  return { source, home, pm, raw, git };
}

test("CLI preserves a complete skill tree without running support files or lifecycle scripts", async () => {
  const { source, home, pm, raw } = fixture();
  await pm.init();
  await pm.install(`git:${source}`);
  const root = pm.packageDir("bundle");
  expect(fs.readFileSync(path.join(root, "skills/category/focus/SKILL.md"), "utf8")).toBe(raw);
  expect(fs.readFileSync(path.join(root, "skills/category/focus/references/guide.md"), "utf8")).toBe("Reference bytes\n");
  expect(fs.readFileSync(path.join(root, "skills/category/focus/assets/sample.bin"))).toEqual(Buffer.from([0, 128, 255]));
  expect(fs.existsSync(path.join(root, "skills/category/focus/scripts/run.sh"))).toBe(true);
  expect(fs.existsSync(path.join(home, ".fez/packages/git/bundle/SHOULD_NOT_EXECUTE"))).toBe(false);
  expect(skillsInstalled(path.join(home, ".fez")).map(skill => skill.id).sort()).toEqual(["category/focus", "legacy"]);
}, 15_000);

test("CLI rejects linked support files rather than copying data outside the skill tree", async () => {
  const { source, pm } = fixture(true);
  await pm.init();
  await expect(pm.install(`git:${source}`)).rejects.toThrow(/symlink|unsafe|escap/i);
  expect(fs.existsSync(path.join(pm.packageDir("bundle"), "skills/category/focus/scripts/escape"))).toBe(false);
}, 15_000);

test("CLI updates replace package-owned skill files while preserving personal copies", async () => {
  const { source, home, pm, git } = fixture();
  await pm.init();
  await pm.install(`git:${source}`);
  const personal = path.join(home, ".fez/skills/legacy.md");
  fs.mkdirSync(path.dirname(personal), { recursive: true });
  fs.writeFileSync(personal, "My edited personal copy");
  fs.rmSync(path.join(source, "skills/legacy.md"));
  fs.rmSync(path.join(source, "skills/category/focus/assets"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills/legacy"));
  fs.writeFileSync(path.join(source, "skills/legacy/SKILL.md"), "---\ndescription: New folder version\n---\nNew instructions");
  git("add", "."); git("commit", "-qm", "replace old skill layout");
  await pm.update("bundle");
  expect(fs.existsSync(path.join(pm.packageDir("bundle"), "skills/legacy.md"))).toBe(false);
  expect(fs.existsSync(path.join(pm.packageDir("bundle"), "skills/category/focus/assets/sample.bin"))).toBe(false);
  expect(fs.readFileSync(path.join(pm.packageDir("bundle"), "skills/legacy/SKILL.md"), "utf8")).toContain("New instructions");
  expect(fs.readFileSync(personal, "utf8")).toBe("My edited personal copy");
  expect(skillsInstalled(path.join(home, ".fez")).filter(skill => skill.id === "legacy")).toHaveLength(1);
}, 15_000);

test("CLI validates old destination resources before removing a skills tree on update", async () => {
  const { source, home, pm } = fixture();
  await pm.init();
  await pm.install(`git:${source}`);
  const outside = path.join(home, "personal.txt");
  fs.writeFileSync(outside, "Keep me");
  const root = pm.packageDir("bundle");
  fs.symlinkSync(outside, path.join(root, "skills/stale-link"));
  await expect(pm.update("bundle")).rejects.toThrow(/symlink|unsafe|escap/i);
  expect(fs.readFileSync(path.join(root, "skills/legacy.md"), "utf8")).toContain("Legacy body");
  expect(fs.readFileSync(outside, "utf8")).toBe("Keep me");
}, 15_000);

test("CLI refuses a package name and skills path that overlap its fetched source", async () => {
  const { source, home, pm, git } = fixture();
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  manifest.fez.skills.dir = "git";
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify(manifest));
  fs.renameSync(path.join(source, "skills"), path.join(source, "git"));
  git("add", "."); git("commit", "-qm", "overlapping layout");
  const renamed = path.join(path.dirname(source), "git");
  fs.renameSync(source, renamed);
  await pm.init();
  await expect(pm.install(`git:${renamed}`)).rejects.toThrow(/overlap/);
  expect(fs.existsSync(path.join(home, ".fez/packages/git/git/git/category/focus/SKILL.md"))).toBe(true);
}, 15_000);
