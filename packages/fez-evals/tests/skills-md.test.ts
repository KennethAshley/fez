import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsInstalled, parseSkillMd } from "../../../src/extensions/skills-md";

describe("skillsInstalled", () => {
  it("finds fez.skills packages and reads frontmatter", () => {
    const home = mkdtempSync(join(tmpdir(), "fez-skills-"));
    const pkg = join(home, "packages", "gh-x-ponytail");
    mkdirSync(join(pkg, "skills"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "gh-x-ponytail", fez: { skills: { dir: "skills" } } }));
    writeFileSync(join(pkg, "skills", "ponytail.md"), "---\ndescription: lazy senior dev\n---\nBe lazy.");
    writeFileSync(join(pkg, "skills", "no-desc.md"), "No frontmatter.");
    const found = skillsInstalled(home);
    expect(found).toHaveLength(1); // description required; no-desc skipped
    expect(found[0]).toMatchObject({ pkg: "gh-x-ponytail", id: "ponytail", name: "ponytail", description: "lazy senior dev" });
    expect(found[0].path.endsWith("skills/ponytail.md")).toBe(true);
  });
  it("parseSkillMd defaults name to the stem", () => {
    expect(parseSkillMd("---\nname: The Pony\ndescription: d\n---\nB", "pony"))
      .toEqual({ name: "The Pony", description: "d", body: "B" });
    expect(parseSkillMd("plain", "pony").name).toBe("pony");
  });
  it("refuses a dir that escapes the package", () => {
    const home = mkdtempSync(join(tmpdir(), "fez-skills-escape-"));
    const pkg = join(home, "packages", "leaky");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "leaky", fez: { skills: { dir: "../evil" } } }));
    // A readable dir OUTSIDE packages/leaky/, with a legit-shaped skill —
    // "../evil" from packages/leaky/ resolves to packages/evil/, a sibling
    // package's dir "leaky" has no business reading.
    const evil = join(home, "packages", "evil");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "secret.md"), "---\ndescription: leaked\n---\nx");
    expect(skillsInstalled(home)).toEqual([]);
  });
  it("discovers folder entrypoints without promoting their reference markdown", () => {
    const home = mkdtempSync(join(tmpdir(), "fez-skill-folders-"));
    const pkg = join(home, "packages", "bundle");
    mkdirSync(join(pkg, "skills", "focus", "references"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ fez: { skills: {} } }));
    writeFileSync(join(pkg, "skills", "focus", "SKILL.md"), "---\nname: focus\ndescription: Focus help\ndisable-model-invocation: true\n---\nRead references/guide.md.");
    writeFileSync(join(pkg, "skills", "focus", "references", "guide.md"), "---\ndescription: Not a skill\n---\nReference");
    writeFileSync(join(pkg, "skills", "legacy.md"), "---\ndescription: Old layout\n---\nLegacy");
    expect(skillsInstalled(home)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "focus", path: join(pkg, "skills", "focus", "SKILL.md"), disableModelInvocation: true }),
      expect.objectContaining({ id: "legacy" }),
    ]));
    expect(skillsInstalled(home)).toHaveLength(2);
  });
  it("does not discover symlinked packages, skill dirs, entrypoints, or flat files", () => {
    const home = mkdtempSync(join(tmpdir(), "fez-skill-links-"));
    const pkg = join(home, "packages", "bundle");
    mkdirSync(join(pkg, "skills", "linked-entry"), { recursive: true });
    const outside = join(home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "---\ndescription: Outside\n---\nPrivate");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ fez: { skills: {} } }));
    symlinkSync(join(outside, "SKILL.md"), join(pkg, "skills", "linked-entry", "SKILL.md"));
    symlinkSync(join(outside, "SKILL.md"), join(pkg, "skills", "linked.md"));
    symlinkSync(outside, join(pkg, "skills", "linked-dir"));
    symlinkSync(pkg, join(home, "packages", "linked-package"));
    expect(skillsInstalled(home)).toEqual([]);
  });
  it("treats a declared root SKILL.md as the single skill, with all descendants as resources", () => {
    const home = mkdtempSync(join(tmpdir(), "fez-skill-root-"));
    const pkg = join(home, "packages", "bundle");
    mkdirSync(join(pkg, "focus", "references", "nested"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ fez: { skills: { dir: "focus" } } }));
    writeFileSync(join(pkg, "focus", "SKILL.md"), "---\ndescription: Main skill\n---\nBody");
    writeFileSync(join(pkg, "focus", "references", "nested", "SKILL.md"), "---\ndescription: Reference\n---\nBody");
    expect(skillsInstalled(home).map(skill => skill.id)).toEqual(["focus"]);
  });
  it("withholds the package if a support resource is linked outside the installed tree", () => {
    const home = mkdtempSync(join(tmpdir(), "fez-skill-resource-link-"));
    const pkg = join(home, "packages", "bundle");
    mkdirSync(join(pkg, "skills", "focus", "references"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ fez: { skills: {} } }));
    writeFileSync(join(pkg, "skills", "focus", "SKILL.md"), "---\ndescription: Main skill\n---\nRead references/private.md");
    writeFileSync(join(home, "private.md"), "Outside data");
    symlinkSync(join(home, "private.md"), join(pkg, "skills", "focus", "references", "private.md"));
    expect(skillsInstalled(home)).toEqual([]);
  });
  it("parses display metadata without changing quoted commas or enabling manual-only skills", () => {
    expect(parseSkillMd("---\nname: 'Focus ''now'''\ndescription: >-\n  Start with one task.\n  Keep it small.\noptions: [lite, 'slow, steady', \"full\"]\ndisable-model-invocation: \"TRUE\"\n---\nBody", "fallback"))
      .toEqual({ name: "Focus 'now'", description: "Start with one task. Keep it small.", options: ["lite", "slow, steady", "full"], disableModelInvocation: true, body: "Body" });
    expect(parseSkillMd("---\nname: |\n  Focus\n  now\ndescription: \"Line one\\nline two\"\noptions:\n  - lite\n  - 'slow, steady'\ndisable-model-invocation: false\n---\n", "fallback"))
      .toMatchObject({ name: "Focus now", description: "Line one line two", options: ["lite", "slow, steady"], disableModelInvocation: false });
    expect(parseSkillMd("---\ndescription: d\ndisable-model-invocation: maybe\n---\n", "x").disableModelInvocation).toBe(true);
  });
});
