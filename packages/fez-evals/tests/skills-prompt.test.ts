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
