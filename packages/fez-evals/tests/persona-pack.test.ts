import { describe, expect, test } from "vitest";
import { validatePersonaFile, mergeDefaults, KNOWN_EXTRA_KEYS } from "@fez/protocol";

/**
 * Persona validation + pack-defaults gate (GAPS item 18, Buzz's
 * pack-validate error/warning split): structural failures error, style
 * and typo-class problems warn, and pack defaults merge UNDER persona
 * frontmatter (persona wins).
 */

const good = `---
harness: claude-code
description: search the web, find papers
---
You research things.
`;

describe("validatePersonaFile", () => {
  test("clean persona: no errors, no warnings", () => {
    const v = validatePersonaFile(good, "researcher", ["claude-code", "pi"]);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  test("missing harness errors; missing frontmatter errors", () => {
    expect(validatePersonaFile("---\ndescription: x\n---\nbody", "a").errors.join()).toMatch(/harness/);
    expect(validatePersonaFile("just a prompt", "a").errors.join()).toMatch(/frontmatter/);
  });

  test("unknown extra key warns (typo class); known keys don't", () => {
    const typo = `---\nharness: pi\ndescription: d\nidleexit: 30m\n---\nb`;
    const v = validatePersonaFile(typo, "a", ["pi"]);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join()).toMatch(/idleexit/);
    const ok = `---\nharness: pi\ndescription: d\nidleExit: 30m\nmodel: x\n---\nb`;
    expect(validatePersonaFile(ok, "a", ["pi"]).warnings).toEqual([]);
    expect(KNOWN_EXTRA_KEYS.has("idleExit")).toBe(true);
  });

  test("no description warns (routing quality); unknown harness warns, not errors", () => {
    const v = validatePersonaFile(`---\nharness: router\n---\nb`, "fez", ["claude-code"]);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join()).toMatch(/description/);
    expect(v.warnings.join()).toMatch(/router/);
  });

  test("path-unsafe id and oversized body error", () => {
    expect(validatePersonaFile(good, "../evil").errors.join()).toMatch(/path/);
    const fat = `---\nharness: pi\ndescription: d\n---\n${"x".repeat(300 * 1024)}`;
    expect(validatePersonaFile(fat, "a").errors.join()).toMatch(/exceeds/);
  });
});

describe("mergeDefaults", () => {
  test("fills absent keys; persona keys always win", () => {
    const merged = mergeDefaults(`---\nharness: claude-code\n---\nprompt`, { harness: "pi", model: "gpt-oss", idleExit: "30m" });
    expect(merged).toMatch(/harness: claude-code/); // persona won
    expect(merged).not.toMatch(/harness: pi/);
    expect(merged).toMatch(/model: gpt-oss/);
    expect(merged).toMatch(/idleExit: 30m/);
    const v = validatePersonaFile(merged, "a", ["claude-code"]);
    expect(v.errors).toEqual([]);
  });

  test("file without frontmatter gains one from defaults", () => {
    const merged = mergeDefaults("just a prompt", { harness: "pi", description: "does things" });
    expect(validatePersonaFile(merged, "a", ["pi"]).errors).toEqual([]);
  });
});
