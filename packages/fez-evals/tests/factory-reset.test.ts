import { describe, expect, it, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { factoryResetPlan, executeFactoryReset } from "../../../src/identity/reset.js";
import { registerResetCommand } from "../../../src/cli/cmd-reset.js";

/**
 * The factory-reset PLAN is the one definition of what "fez's local
 * state" is — the CLI prints it, the executor walks it, and the desktop's
 * Rust factory_reset mirrors it. These tests pin the list so growing a
 * new state home forces a deliberate edit here, not a silent omission
 * that leaves half an identity behind.
 */
describe("factoryResetPlan", () => {
  it("on darwin: ~/.fez, both webview storage dirs, both keychain services", () => {
    const plan = factoryResetPlan({ home: "/Users/x", platform: "darwin" });
    expect(plan.dirs).toEqual([
      "/Users/x/.fez",
      "/Users/x/Library/WebKit/com.fez.desktop",
      "/Users/x/Library/Caches/com.fez.desktop",
    ]);
    // fez-keys carries the user's identity AND every agent's key;
    // fez-skill-env carries skill secrets the desktop stored.
    expect(plan.keychainServices).toEqual(["fez-keys", "fez-skill-env"]);
  });

  it("elsewhere: only ~/.fez — no keychain, no webview dirs", () => {
    const plan = factoryResetPlan({ home: "/home/x", platform: "linux" });
    expect(plan.dirs).toEqual(["/home/x/.fez"]);
    expect(plan.keychainServices).toEqual([]);
  });
});

describe("executeFactoryReset", () => {
  it("removes what exists, tolerates what doesn't, reports only real removals", () => {
    const base = mkdtempSync(path.join(tmpdir(), "fez-reset-"));
    const fez = path.join(base, ".fez");
    mkdirSync(path.join(fez, "personas"), { recursive: true });
    writeFileSync(path.join(fez, "settings.json"), "{}");
    const ghost = path.join(base, "never-existed");

    const { removed, keysDeleted } = executeFactoryReset({ dirs: [fez, ghost], keychainServices: [] });
    expect(existsSync(fez)).toBe(false);
    expect(removed).toEqual([fez]); // the ghost is not claimed as work done
    expect(keysDeleted).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });
});

/**
 * `fez reset` refuses to be a shrug: without --factory it must not touch
 * anything and must say so. Registered against a bare Command, same
 * pattern as cli-tool-alias.test.ts.
 */
describe("fez reset registration", () => {
  const program = new Command();
  registerResetCommand(program);
  const reset = program.commands.find((c) => c.name() === "reset");

  test("the command exists, with --factory and --yes", () => {
    expect(reset).toBeDefined();
    const flags = reset!.options.map((o) => o.long);
    expect(flags).toContain("--factory");
    expect(flags).toContain("--yes");
  });

  test("its description says irreversible — the word is the warning", () => {
    expect(reset!.description()).toMatch(/irreversible/);
  });
});
