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

  it("leaves every other line untouched", () => {
    const out = attachSkill(persona, "polls", "npm:@fezchat/polls")!;
    expect(out).toContain("aliases: [subnets, bittensor]");
    expect(out).toContain("owner: 4d9a4f80");
    expect(out).toContain("You are @scout.");
    // Unknown/extension keys and the body must survive verbatim.
    expect(out.split("\n").length).toBe(persona.split("\n").length);
  });

  it("attaching something already declared changes nothing", () => {
    expect(attachSkill(persona, "bittensor")).toBeUndefined();
  });

  it("detaches, preserving the sources of the survivors", () => {
    const withSource = persona.replace("fez-wallet]", "fez-wallet=npm:@fezchat/wallet]");
    const out = detachSkill(withSource, "bittensor")!;
    expect(out).toContain("mcpServers: [fez-wallet=npm:@fezchat/wallet]");
  });

  it("detaching the last skill leaves an empty list, not a broken line", () => {
    const one = persona.replace("mcpServers: [bittensor, fez-wallet]", "mcpServers: [solo]");
    expect(detachSkill(one, "solo")!).toContain("mcpServers: []");
  });

  it("detaching something not declared changes nothing", () => {
    expect(detachSkill(persona, "github")).toBeUndefined();
  });

  it("a persona with no mcpServers line gains one on attach", () => {
    const bare = `---\nharness: pi\ndescription: hi\n---\nYou are bare.\n`;
    const out = attachSkill(bare, "wallet", "npm:@fezchat/wallet")!;
    expect(out).toContain("mcpServers: [wallet=npm:@fezchat/wallet]");
    expect(out).toContain("harness: pi");
    expect(out).toContain("You are bare.");
  });

  it("a file with no frontmatter is refused rather than mangled", () => {
    expect(attachSkill("just a prompt, no frontmatter\n", "wallet")).toBeUndefined();
  });
});
