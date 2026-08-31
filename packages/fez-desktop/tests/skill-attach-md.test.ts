import { describe, it, expect } from "vitest";
import { attachSkill, detachSkill, declaredSkills } from "../src/skill-attach";

const persona = "---\nharness: pi\nmcpServers: [wallet]\n---\nBody.";

describe("skill-attach on the skills: key", () => {
  it("attaches into skills: without touching mcpServers:", () => {
    const out = attachSkill(persona, "ponytail", undefined, "skills")!;
    expect(out).toContain("skills: [ponytail]");
    expect(out).toContain("mcpServers: [wallet]");
    expect(declaredSkills(out, "skills").map((s) => s.name)).toEqual(["ponytail"]);
    expect(declaredSkills(out).map((s) => s.name)).toEqual(["wallet"]); // default key unchanged
  });
  it("detaches from the right key", () => {
    const out = detachSkill(attachSkill(persona, "ponytail", undefined, "skills")!, "ponytail", "skills")!;
    expect(out).not.toContain("skills: [");
    expect(out).toContain("mcpServers: [wallet]");
  });
});
