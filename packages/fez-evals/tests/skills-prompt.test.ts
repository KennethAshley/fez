import { describe, it, expect } from "vitest";
import { resolveAttachedSkills, skillsPromptSection, skillsEnvJson, manualSkillForInput } from "../../fez-acp/src/skills-prompt";

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
  it("env json maps name to path, setting riding along when attached with one", () => {
    expect(JSON.parse(skillsEnvJson([pony]))).toEqual({ ponytail: { path: "/x/ponytail.md" } });
    expect(JSON.parse(skillsEnvJson([{ ...pony, setting: "ultra" }]))).toEqual({
      ponytail: { path: "/x/ponytail.md", setting: "ultra" },
    });
  });
  it("withholds manual-only skills from both automatic discovery and the model's loader", () => {
    const manual = { ...pony, disableModelInvocation: true };
    expect(skillsPromptSection([manual])).toBeUndefined();
    expect(JSON.parse(skillsEnvJson([manual]))).toEqual({});
    expect(resolveAttachedSkills(["ponytail"], [manual]).attached).toEqual([manual]);
  });
  it("activates only an exact leading owner command, including the skill author's direct slash name", () => {
    const manual = { ...pony, id: "category/adhd", name: "i-have-adhd", disableModelInvocation: true, setting: "lite" };
    for (const content of ["/skill category/adhd help", "/skill i-have-adhd help", "/i-have-adhd help", "@helper /i-have-adhd help"]) {
      expect(manualSkillForInput([manual], { content, author: "owner", owner: "owner", persona: "helper" })).toEqual(manual);
    }
    for (const content of ["Earlier: /i-have-adhd", "```\n/i-have-adhd\n```", "/i-have-adhd-extra", "/skill unknown", "@other /i-have-adhd", "use /skill i-have-adhd"]) {
      expect(manualSkillForInput([manual], { content, author: "owner", owner: "owner", persona: "helper" })).toBeUndefined();
    }
    expect(manualSkillForInput([manual], { content: "/i-have-adhd", author: "peer", owner: "owner", persona: "helper" })).toBeUndefined();
    expect(manualSkillForInput([manual], { content: "/i-have-adhd", author: "", owner: "", persona: "helper" })).toBeUndefined();
  });
  it("settings resolve by declared identifier and reach the section line", () => {
    const { attached } = resolveAttachedSkills(["ponytail"], [pony], { ponytail: "ultra" });
    expect(attached[0].setting).toBe("ultra");
    expect(skillsPromptSection(attached)).toContain("- ponytail: lazy senior dev (attached with: ultra)");
  });
  it("dedupes two attached skills sharing a frontmatter name, keeping the first and warning", () => {
    const impostor = { pkg: "q", id: "fake-ponytail", name: "ponytail", description: "not lazy", path: "/y/ponytail.md" };
    const warn = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const r = resolveAttachedSkills(["ponytail", "fake-ponytail"], [pony, impostor]);
      expect(r.attached).toEqual([pony]);
      expect(r.missing).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toContain("q");
    } finally {
      console.warn = warn;
    }
  });
});
