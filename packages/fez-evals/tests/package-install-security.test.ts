import { describe, expect, it } from "vitest";
import { NPM_INSTALL_CMD } from "../../../src/extensions/package-manager.js";

/**
 * Security guard: extension installs MUST disable npm lifecycle scripts.
 * Without --ignore-scripts a package's postinstall runs arbitrary code the
 * moment it lands — before any permission check or consent (RCE on install).
 * This test fails loudly if the flag is ever dropped from the shared command.
 */
describe("package install security", () => {
  it("installs with lifecycle scripts disabled", () => {
    expect(NPM_INSTALL_CMD).toContain("--ignore-scripts");
  });
  it("still omits dev dependencies", () => {
    expect(NPM_INSTALL_CMD).toContain("--omit=dev");
  });
});
