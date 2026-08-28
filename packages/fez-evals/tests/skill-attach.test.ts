import { describe, it, expect } from "vitest";
import { attachSkill, detachSkill, declaredSkills } from "../../fez-desktop/src/skill-attach.js";

const persona = `---
harness: claude-code
owner: 4d9a4f80
aliases: [subnets, bittensor]
mcpServers: [bittensor, fez-wallet]
description: your Bittensor scout
---
You are @scout.
`;

const bare = `---\nharness: pi\ndescription: hi\n---\nYou are bare.\n`;

/**
 * Diffing helper for the round-trip guarantee: normalize the one line
 * these functions are allowed to touch, then the two strings must be
 * identical. Catches anything that moves outside that line — the class
 * of bug a `toContain` + line-count check cannot see.
 */
function normalizeSkillsLine(content: string): string {
  return content.replace(/^mcpServers:\s*\[[^\]]*\]/m, "mcpServers: [__NORMALIZED__]");
}

/**
 * For the insert-new-line path (no prior `mcpServers:` line): strip the
 * exact line + trailing newline that attachSkill inserted, and what's
 * left must be byte-identical to the original.
 */
function withoutInsertedLine(content: string, nl: string): string {
  return content.replace(new RegExp(`mcpServers:\\s*\\[[^\\]]*\\]${nl}`), "");
}

describe("editing a persona's declared skills", () => {
  it("reads what is declared, with sources", () => {
    expect(declaredSkills(persona)).toEqual([
      { name: "bittensor", source: undefined },
      { name: "fez-wallet", source: undefined },
    ]);
  });

  it("attaches in the portable form", () => {
    const out = attachSkill(persona, "wallet", "npm:@fezchat/wallet")!;
    expect(out).toContain("mcpServers: [bittensor, fez-wallet, wallet=npm:@fezchat/wallet]");
  });

  it("attaches a source-less skill as a bare name", () => {
    expect(attachSkill(persona, "scratch")!).toContain("mcpServers: [bittensor, fez-wallet, scratch]");
  });

  it("leaves every other line untouched (replace-existing-line path)", () => {
    const out = attachSkill(persona, "polls", "npm:@fezchat/polls")!;
    expect(out).toContain("aliases: [subnets, bittensor]");
    expect(out).toContain("owner: 4d9a4f80");
    expect(out).toContain("You are @scout.");
    // The whole file, with only the touched line normalized out, must be
    // identical — not just line-count-identical.
    expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(persona));
    expect(out.split("\n").length).toBe(persona.split("\n").length);
  });

  it("attaching something already declared changes nothing", () => {
    expect(attachSkill(persona, "bittensor")).toBeUndefined();
  });

  it("detaches, preserving the sources of the survivors", () => {
    const withSource = persona.replace("fez-wallet]", "fez-wallet=npm:@fezchat/wallet]");
    const out = detachSkill(withSource, "bittensor")!;
    expect(out).toContain("mcpServers: [fez-wallet=npm:@fezchat/wallet]");
    expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(withSource));
  });

  it("detaching the last skill leaves an empty list, not a broken line", () => {
    const one = persona.replace("mcpServers: [bittensor, fez-wallet]", "mcpServers: [solo]");
    expect(detachSkill(one, "solo")!).toContain("mcpServers: []");
  });

  it("detaching something not declared changes nothing", () => {
    expect(detachSkill(persona, "github")).toBeUndefined();
  });

  it("detaching from a persona with no frontmatter changes nothing", () => {
    expect(detachSkill("just a prompt, no frontmatter\n", "wallet")).toBeUndefined();
  });

  it("a persona with no mcpServers line gains one on attach", () => {
    const out = attachSkill(bare, "wallet", "npm:@fezchat/wallet")!;
    expect(out).toContain("mcpServers: [wallet=npm:@fezchat/wallet]");
    expect(out).toContain("harness: pi");
    expect(out).toContain("You are bare.");
    expect(withoutInsertedLine(out, "\n")).toBe(bare);
  });

  it("a file with no frontmatter is refused rather than mangled", () => {
    expect(attachSkill("just a prompt, no frontmatter\n", "wallet")).toBeUndefined();
  });

  describe("CRLF-encoded personas", () => {
    const crlfPersona = persona.replace(/\n/g, "\r\n");
    const crlfBare = bare.replace(/\n/g, "\r\n");

    it("attach on an existing line preserves CRLF everywhere else", () => {
      const out = attachSkill(crlfPersona, "polls", "npm:@fezchat/polls")!;
      expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(crlfPersona));
      // No bare \n anywhere — every newline stays \r\n.
      expect(/(?<!\r)\n/.test(out)).toBe(false);
    });

    it("detach on an existing line preserves CRLF everywhere else", () => {
      const out = detachSkill(crlfPersona, "bittensor")!;
      expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(crlfPersona));
      expect(/(?<!\r)\n/.test(out)).toBe(false);
    });

    it("attach with no existing line inserts a CRLF line, not a mixed one", () => {
      const out = attachSkill(crlfBare, "wallet", "npm:@fezchat/wallet")!;
      expect(withoutInsertedLine(out, "\r\n")).toBe(crlfBare);
      expect(/(?<!\r)\n/.test(out)).toBe(false);
    });
  });

  describe("skill names/sources containing $-replacement patterns", () => {
    it("a $& skill name on the replace-existing-line path is inserted literally", () => {
      const out = attachSkill(persona, "pay$&day")!;
      expect(out).toContain("mcpServers: [bittensor, fez-wallet, pay$&day]");
      expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(persona));
    });

    it("a $& source on the replace-existing-line path is inserted literally", () => {
      const out = attachSkill(persona, "wallet", "npm:@x$&y")!;
      expect(out).toContain("mcpServers: [bittensor, fez-wallet, wallet=npm:@x$&y]");
      expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(persona));
    });

    it("a $& skill/source on the insert-new-line path is inserted literally", () => {
      const out = attachSkill(bare, "pay$&day", "npm:@x$&y")!;
      expect(out).toContain("mcpServers: [pay$&day=npm:@x$&y]");
      expect(withoutInsertedLine(out, "\n")).toBe(bare);
    });

    it("detach preserves a survivor's $& source literally", () => {
      // Function-form replacer: a plain-string replacement argument would
      // itself fall into the `$&` trap this test exists to catch.
      const withWeirdSource = persona.replace("fez-wallet]", () => "fez-wallet=npm:@x$&y]");
      const out = detachSkill(withWeirdSource, "bittensor")!;
      expect(out).toContain("mcpServers: [fez-wallet=npm:@x$&y]");
      expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(withWeirdSource));
    });
  });

  it("a body line that merely looks like mcpServers: [...] is never mistaken for the frontmatter's", () => {
    const trap = `---\nharness: pi\ndescription: hi\n---\nSample config:\nmcpServers: [fake, entry]\nYou are bare.\n`;
    // The frontmatter has no real line, so nothing is declared...
    expect(declaredSkills(trap)).toEqual([]);
    // ...and attach must insert into the frontmatter, not "replace" the
    // look-alike line sitting in the body.
    const out = attachSkill(trap, "wallet", "npm:@fezchat/wallet")!;
    expect(out).toContain("mcpServers: [wallet=npm:@fezchat/wallet]");
    expect(out).toContain("Sample config:");
    expect(out).toContain("mcpServers: [fake, entry]");
    expect(out).toContain("You are bare.");
  });
});
