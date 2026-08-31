import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
});
