import { describe, it, expect } from "vitest";
import { parseFrontmatter, serializePersona } from "../../../src/identity/personas.js";

// The brief's test calls parsePersona(name, raw); the file's real entry
// point for frontmatter parsing is the exported parseFrontmatter(raw) —
// it doesn't take an id, so the "x" name argument is dropped. Every
// assertion from the brief is kept.
describe("skills: frontmatter key", () => {
  it("parses names and sources with the mcpServers grammar", () => {
    const p = parseFrontmatter("---\nharness: pi\nskills: [ponytail, review=npm:@fezchat/ponytail]\nmcpServers: [wallet]\n---\nBody.");
    expect(p.skills).toEqual(["ponytail", "review"]);
    expect(p.skillSources).toEqual({ review: "npm:@fezchat/ponytail" });
    expect(p.mcpServers).toEqual(["wallet"]); // untouched
    expect(p.extra.skills).toBeUndefined();   // known key, not extra
  });
  it("defaults to empty and round-trips through serializePersona", () => {
    const p = parseFrontmatter("---\nharness: pi\n---\nBody.");
    expect(p.skills).toEqual([]);
    const out = serializePersona("pi", [], ["wallet"], "Body.", ["ponytail", "review=npm:@fezchat/ponytail"]);
    expect(out).toContain("skills: [ponytail, review=npm:@fezchat/ponytail]");
    const back = parseFrontmatter(out);
    expect(back.skills).toEqual(["ponytail", "review"]);
  });
});
