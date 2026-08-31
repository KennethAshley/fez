import { describe, it, expect } from "vitest";
import { resolveAttachedSkills, skillsPromptSection, skillsEnvJson } from "../../fez-acp/src/skills-prompt";

const pony = { pkg: "p", id: "ponytail", name: "ponytail", description: "lazy senior dev", path: "/x/ponytail.md" };

describe("skills prompt", () => {
  it("resolves declared against installed, reports missing", () => {
    const r = resolveAttachedSkills(["ponytail", "ghost"], [pony]);
    expect(r.attached).toEqual([pony]);
    expect(r.missing).toEqual(["ghost"]);
  });
  it("section lists name+description, never the body; empty -> undefined", () => {
    const s = skillsPromptSection([pony])!;
    expect(s).toContain("fez_load_skill");
    expect(s).toContain("- ponytail: lazy senior dev");
    expect(skillsPromptSection([])).toBeUndefined();
  });
  it("env json maps name to path", () => {
    expect(JSON.parse(skillsEnvJson([pony]))).toEqual({ ponytail: "/x/ponytail.md" });
  });
});
