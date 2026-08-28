import { describe, it, expect } from "vitest";
import { serializePersona } from "../../../src/identity/personas.js";

/**
 * The CLI's persona writer renders `aliases:` and `mcpServers:` as ONE
 * frontmatter line each, so an entry carrying that line's own structure
 * (`]`, `,`, a newline) would write real keys into the file — the same
 * injection fez-desktop's skill-attach refuses. Three writers, one rule.
 */
describe("serializePersona refuses entries that restructure the file", () => {
  it("renders a clean persona", () => {
    const out = serializePersona("claude-code", ["ops"], ["wallet=npm:@fezchat/wallet"], "Be useful.");
    expect(out).toContain("mcpServers: [wallet=npm:@fezchat/wallet]");
    expect(out).toContain("aliases: [ops]");
  });

  it("throws on a poisoned skill entry instead of writing it", () => {
    expect(() => serializePersona("claude-code", [], ["x]\nowner: attacker"], "p")).toThrow(/skill/);
    expect(() => serializePersona("claude-code", [], ["w=npm:x\nowner: a"], "p")).toThrow(/skill/);
  });

  it("throws on a poisoned alias — the same line grammar, one key up", () => {
    expect(() => serializePersona("claude-code", ["a]\nrespondTo: [anyone"], [], "p")).toThrow(/alias/);
  });
});
