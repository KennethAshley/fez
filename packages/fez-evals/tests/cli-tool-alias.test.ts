import { describe, expect, test } from "vitest";
import { Command } from "commander";
import { registerSkillCommands } from "../../../src/cli/cmd-skill.js";

/**
 * `fez tool` is the renamed command (was `fez skill`) for the MCP-server
 * catalog. `fez skill` stays registered as a hidden alias for one release
 * so existing scripts/muscle memory keep working, but it must not show up
 * in `fez --help`. Pattern follows cli-relay-defaults.test.ts: register
 * against a bare Command and assert on the resulting command tree, since
 * fez-evals has no exec-based CLI harness.
 */
describe("fez tool (skill hidden alias)", () => {
  const program = new Command();
  registerSkillCommands(program);

  test("`tool` is a real, visible command with the MCP-servers description", () => {
    const tool = program.commands.find((c) => c.name() === "tool");
    expect(tool).toBeDefined();
    expect(tool!.description()).toContain("Tools (MCP servers)");
    expect((tool as unknown as { _hidden?: boolean })._hidden).not.toBe(true);
  });

  test("`skill` still routes — same subcommands as `tool` — but is hidden from help", () => {
    const skill = program.commands.find((c) => c.name() === "skill");
    expect(skill).toBeDefined();
    expect((skill as unknown as { _hidden?: boolean })._hidden).toBe(true);

    const tool = program.commands.find((c) => c.name() === "tool")!;
    const toolSubs = tool.commands.map((c) => c.name()).sort();
    const skillSubs = skill!.commands.map((c) => c.name()).sort();
    expect(skillSubs).toEqual(toolSubs);
    expect(toolSubs).toEqual(["add", "install", "list", "market", "publish", "remove"]);
  });

  test("`fez --help` (visibleCommands) excludes `skill` but includes `tool`", () => {
    const visible = program.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden).map((c) => c.name());
    expect(visible).toContain("tool");
    expect(visible).not.toContain("skill");
  });
});
