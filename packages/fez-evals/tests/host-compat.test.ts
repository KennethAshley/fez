import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareSemver, minFezVersionError, FEZ_VERSION } from "../../../src/extensions/host-compat.js";

/**
 * The compat contract: a package built for a newer fez refuses to
 * install on an older one, loudly and at install time — not as an
 * undefined-method crash mid-task a week later.
 */
describe("host compat", () => {
  it("compares x.y.z versions numerically, not lexically", () => {
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.2.0", "0.10.0")).toBeLessThan(0); // 2 < 10
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareSemver("0.1", "0.1.0")).toBe(0); // missing parts are zero
  });

  it("accepts a package with no minFezVersion (older packages keep installing)", () => {
    expect(minFezVersionError(undefined, "0.1.0")).toBeNull();
  });

  it("accepts when the host is new enough", () => {
    expect(minFezVersionError("0.1.0", "0.1.0")).toBeNull();
    expect(minFezVersionError("0.1.0", "0.2.0")).toBeNull();
  });

  it("refuses when the host is too old, naming both versions", () => {
    const err = minFezVersionError("0.2.0", "0.1.0");
    expect(err).toContain("0.2.0");
    expect(err).toContain("0.1.0");
  });

  it("refuses an unparseable requirement rather than guessing", () => {
    expect(minFezVersionError("banana", "0.1.0")).toContain("banana");
  });

  it("exports the host version the CLI reports", () => {
    expect(FEZ_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

it("desktop and CLI advertise the same miner-capable host contract", () => {
  const rust = readFileSync(new URL('../../fez-desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8');
  expect(rust.match(/const FEZ_VERSION: &str = "([^"]+)"/)?.[1]).toBe(FEZ_VERSION);
  expect(minFezVersionError('0.2.1', '0.2.0')).not.toBeNull();
  expect(minFezVersionError('0.2.1')).toBeNull();
});
