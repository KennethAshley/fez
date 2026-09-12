import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { attachedSkills, loadSkillBody } from "../../fez-mcp/src/skills";

describe("fez_load_skill core", () => {
  it("returns the body for an attached name only", () => {
    const dir = mkdtempSync(join(tmpdir(), "fez-mcp-skill-"));
    const p = join(dir, "ponytail.md");
    writeFileSync(p, "---\ndescription: d\n---\nBe lazy.");
    const set = attachedSkills(JSON.stringify({ ponytail: p }));
    expect(loadSkillBody("ponytail", set)).toContain("Be lazy.");
    expect(loadSkillBody("ponytail", set)).toContain(`Base directory: ${dirname(p)}`);
    expect(() => loadSkillBody("evil", set)).toThrow(/ponytail/); // error names the attached set
  });
  it("tolerates absent/garbled env", () => {
    expect(attachedSkills(undefined)).toEqual({});
    expect(attachedSkills("not json")).toEqual({});
  });
  it("refuses a replaced support directory or entrypoint at load time", () => {
    const root = mkdtempSync(join(tmpdir(), "fez-mcp-skill-swap-"));
    mkdirSync(join(root, "focus"));
    writeFileSync(join(root, "focus", "SKILL.md"), "Original");
    const set = attachedSkills(JSON.stringify({ focus: { path: join(root, "focus", "SKILL.md"), root } }));
    renameSync(join(root, "focus"), join(root, "moved"));
    symlinkSync(join(root, "moved"), join(root, "focus"));
    expect(() => loadSkillBody("focus", set)).toThrow(/escape/);
  });
  it("does not load a file changed to manual-only after the automatic catalog was created", () => {
    const root = mkdtempSync(join(tmpdir(), "fez-mcp-skill-manual-"));
    const file = join(root, "SKILL.md");
    writeFileSync(file, "---\ndescription: Private\ndisable-model-invocation: true\n---\nDo not auto-load");
    expect(() => loadSkillBody("focus", attachedSkills(JSON.stringify({ focus: { path: file, root } })))).toThrow(/manual/);
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
    expect(loadSkillBody("old", set)).toContain("Be lazy.");
  });
});
