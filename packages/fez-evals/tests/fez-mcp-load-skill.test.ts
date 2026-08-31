import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachedSkills, loadSkillBody } from "../../fez-mcp/src/skills";

describe("fez_load_skill core", () => {
  it("returns the body for an attached name only", () => {
    const dir = mkdtempSync(join(tmpdir(), "fez-mcp-skill-"));
    const p = join(dir, "ponytail.md");
    writeFileSync(p, "---\ndescription: d\n---\nBe lazy.");
    const set = attachedSkills(JSON.stringify({ ponytail: p }));
    expect(loadSkillBody("ponytail", set)).toContain("Be lazy.");
    expect(() => loadSkillBody("evil", set)).toThrow(/ponytail/); // error names the attached set
  });
  it("tolerates absent/garbled env", () => {
    expect(attachedSkills(undefined)).toEqual({});
    expect(attachedSkills("not json")).toEqual({});
  });
});

describe("fez_load_skill settings", () => {
  it("appends the attached setting to the loaded body; old bare-string env still parses", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fez-mcp-setting-"));
    const p = join(dir, "ponytail.md");
    writeFileSync(p, "Be lazy.");
    const set = attachedSkills(JSON.stringify({ ponytail: { path: p, setting: "ultra" }, old: p }));
    expect(loadSkillBody("ponytail", set)).toContain("[Attached setting: ultra]");
    expect(loadSkillBody("old", set)).toBe("Be lazy.");
  });
});
