import { describe, expect, test } from "vitest";
import { Command } from "commander";
import { registerExtensionCommands } from "../../../src/cli/cmd-extensions.js";

/**
 * `fez discover` (and the since-removed `fez send`) carried a hardcoded commander default of
 * wss://relay.damus.io — they ignored FEZ_RELAY, settings.json, and the
 * fez default entirely, so "the relay set" story on the docs was false
 * for exactly these two commands. The fix: no baked-in default; the
 * action resolves through resolveRelays() like `fez run` does. This gate
 * pins that no relay option grows a hardcoded URL default again.
 */
describe("CLI relay defaults — no command hardcodes a relay URL", () => {
  const program = new Command();
  registerExtensionCommands(program);

  for (const name of ["discover", "run"]) {
    test(`fez ${name}: -r/--relay has no baked-in URL default`, () => {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd, `command ${name} exists`).toBeDefined();
      const relayOpt = cmd!.options.find((o) => o.long === "--relay");
      expect(relayOpt, `${name} has --relay`).toBeDefined();
      expect(relayOpt!.defaultValue).toBeUndefined();
      // the help text shouldn't advertise a relay the code doesn't use
      expect(relayOpt!.description).not.toMatch(/damus/);
    });
  }

  test("fez update is a real command (install's error message advertises it)", () => {
    expect(program.commands.map((c) => c.name())).toContain("update");
  });
});
