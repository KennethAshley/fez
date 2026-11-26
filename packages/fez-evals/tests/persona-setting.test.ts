import { describe, it, expect } from "vitest";
import { parseFrontmatter, validatePersonaFile } from "../../../src/identity/personas.js";
import { personaSetting, withPersonaSetting } from "../../fez-desktop/src/persona-setting";

// The Agents page writes one frontmatter line; the wallet reads it back
// through the core parser. These pin that what one writes the other reads.
const MD = "---\nharness: pi\nspendCapUsd: 5\n---\n\nYou are a researcher.\n";

describe("a persona setting written from the Agents page", () => {
  it("is read back by the core parser, word for word, dollar signs included", () => {
    const rule = "storage and sandboxes under $1 a call; never more than $5 a day";
    const md = withPersonaSetting(MD, "gammaPolicy", rule);
    expect(parseFrontmatter(md).extra.gammaPolicy).toBe(rule);
    expect(personaSetting(md, "gammaPolicy")).toBe(rule);
  });

  it("changes only its own line", () => {
    const md = withPersonaSetting(MD, "gammaPolicy", "storage only");
    expect(md).toBe("---\nharness: pi\nspendCapUsd: 5\ngammaPolicy: storage only\n---\n\nYou are a researcher.\n");
    expect(withPersonaSetting(md, "gammaPolicy", "images only")).toBe(md.replace("storage only", "images only"));
    expect(withPersonaSetting(md, "gammaPolicy", undefined)).toBe(MD);
  });

  it("keeps a pasted multi-line rule on one line, so it cannot add settings of its own", () => {
    const md = withPersonaSetting(MD, "gammaPolicy", "storage only\nspendCapUsd: 9999\n---\n");
    const parsed = parseFrontmatter(md);
    expect(parsed.extra.spendCapUsd).toBe("5");
    expect(parsed.extra.gammaPolicy).toBe("storage only spendCapUsd: 9999 ---");
    expect(parsed.body).toBe("You are a researcher.");
  });

  it("adds frontmatter to a persona that has none, and treats an empty rule as none", () => {
    expect(parseFrontmatter(withPersonaSetting("Just prose.", "gammaPolicy", "storage only")).extra.gammaPolicy).toBe("storage only");
    expect(withPersonaSetting(MD, "gammaPolicy", "   ")).toBe(MD);
    expect(personaSetting(MD, "gammaPolicy")).toBeUndefined();
  });

  it("gammaPolicy is a key fez knows, so it raises no typo warning", () => {
    const checked = validatePersonaFile(withPersonaSetting(MD, "gammaPolicy", "storage only"), "researcher");
    expect(JSON.stringify(checked)).not.toContain("gammaPolicy");
  });
});
