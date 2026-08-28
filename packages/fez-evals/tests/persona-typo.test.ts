import { describe, it, expect } from "vitest";
import { validatePersonaFile, nearestKnownKey, KNOWN_EXTRA_KEYS } from "@fezchat/protocol";
import * as mirror from "../../fez-client/dist/index.js";

/**
 * parseFrontmatter sweeps unknown keys into `extra`, so `mcpServer:`
 * (missing the s) yields an agent with no skills and no complaint. fez
 * can't reject unknown keys — extensions legitimately add them — so a
 * near-miss is called out by name while a genuine extension key is left
 * alone.
 */
describe("near-miss frontmatter keys", () => {
  it("finds the key a typo was reaching for", () => {
    expect(nearestKnownKey("mcpServer")).toBe("mcpServers");
    expect(nearestKnownKey("harnes")).toBe("harness");
    expect(nearestKnownKey("descriptin")).toBe("description");
  });

  it("leaves an unknown extension key alone when it resembles nothing", () => {
    expect(nearestKnownKey("someExtensionKey")).toBeUndefined();
    expect(nearestKnownKey("kanbanColumn")).toBeUndefined();
  });

  it("a key that IS known returns nothing — exact match is not a near miss", () => {
    // shareLevel is in KNOWN_EXTRA_KEYS. The editor calls this for every
    // key it sees, including the valid ones, so exact matches must be silent.
    expect(nearestKnownKey("shareLevel")).toBeUndefined();
    expect(nearestKnownKey("mcpServers")).toBeUndefined();
  });

  it("does not match something merely short", () => {
    // Two edits from nothing meaningful — must not claim a match.
    expect(nearestKnownKey("x")).toBeUndefined();
  });

  it("the warning names the intended key", () => {
    const raw = `---\nharness: pi\nmcpServer: [wallet]\n---\nbody\n`;
    const { warnings } = validatePersonaFile(raw, "bot");
    expect(warnings.some((w) => w.includes("mcpServer") && w.includes('did you mean "mcpServers"'))).toBe(true);
  });

  it("an unrecognized key still warns, just without a suggestion", () => {
    const raw = `---\nharness: pi\ntotallyCustom: 1\n---\nbody\n`;
    const { warnings } = validatePersonaFile(raw, "bot");
    expect(warnings.some((w) => w.includes("totallyCustom"))).toBe(true);
    expect(warnings.some((w) => w.includes("did you mean"))).toBe(false);
  });

  it("a near-miss is a warning, never an error — the key is still kept", () => {
    const raw = `---\nharness: pi\nmcpServer: [wallet]\n---\nbody\n`;
    expect(validatePersonaFile(raw, "bot").errors).toEqual([]);
  });
});

describe("the browser mirror agrees with the CLI", () => {
  for (const key of ["mcpServer", "harnes", "descriptin", "shareLevel", "someExtensionKey", "x", "mcpServers"]) {
    it(`agrees on "${key}"`, () => {
      expect(mirror.nearestKnownKey(key)).toBe(nearestKnownKey(key));
    });
  }

  // The sample-key checks above only prove the matcher agrees on the keys
  // sampled — a key added to KNOWN_EXTRA_KEYS and never mirrored into
  // persona-keys.ts would stay green there unless the sample table
  // happened to exercise it. This diffs the two FULL lists instead, so
  // adding a key on one side and forgetting the other side is a red test,
  // not a silent gap. Built from KNOWN_EXTRA_KEYS (exported) plus the same
  // four literals parseFrontmatter reads directly, so this also proves
  // those four haven't drifted from what the parser actually reads.
  it("the two key lists are identical — this is what makes the mirror a mirror", () => {
    const canonical = ["harness", "aliases", "mcpServers", "description", ...KNOWN_EXTRA_KEYS];
    expect([...mirror.ALL_KNOWN_KEYS].sort()).toEqual([...canonical].sort());
  });
});
