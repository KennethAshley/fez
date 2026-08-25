import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEZ_VERSION } from "../../../src/extensions/host-compat.js";

/**
 * The desktop enforces fez.minFezVersion in Rust (install_package in
 * lib.rs) against its own FEZ_VERSION constant — a deliberate mirror of
 * host-compat.ts, since the webview installer has no TS host to ask.
 * Mirrors drift; this gate makes drift a test failure: the two version
 * constants must be equal, and the Rust gate must actually be wired into
 * install_package (it was dead-bypassed once).
 */
describe("host-compat TS ↔ Rust mirror", () => {
  const libRs = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fez-desktop/src-tauri/src/lib.rs"),
    "utf-8"
  );

  test("Rust FEZ_VERSION equals host-compat.ts FEZ_VERSION", () => {
    const m = libRs.match(/const FEZ_VERSION: &str = "([^"]+)"/);
    expect(m, "lib.rs declares const FEZ_VERSION").toBeTruthy();
    expect(m![1]).toBe(FEZ_VERSION);
  });

  test("install_package calls the compat gate", () => {
    expect(libRs).toMatch(/min_fez_version_error\(\s*pkg\s*\.pointer\("\/fez\/minFezVersion"\)/);
  });
});
