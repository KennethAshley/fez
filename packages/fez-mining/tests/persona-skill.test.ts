import { describe, it, expect } from "vitest";
import { ensureMiningSkill, removeMiningSkill } from "../src/persona-skill.js";

const NONE = `---\nharness: claude-code\naliases: [q]\n---\nquill body\n`;
const HAS = `---\nharness: claude-code\nmcpServers: [web-search, mining=npm:@fezchat/mining]\n---\nbody\n`;

describe("ensureMiningSkill", () => {
  it("adds an mcpServers line when there is none", () => {
    const out = ensureMiningSkill(NONE);
    expect(out).toContain("mcpServers: [mining=npm:@fezchat/mining]");
    expect(out).toContain("harness: claude-code");
    expect(out).toContain("quill body");
  });
  it("appends to an existing mcpServers line without dupes", () => {
    const out = ensureMiningSkill(`---\nharness: x\nmcpServers: [web-search]\n---\nb\n`);
    expect(out).toContain("mcpServers: [web-search, mining=npm:@fezchat/mining]");
  });
  it("is idempotent", () => {
    expect(ensureMiningSkill(HAS)).toBe(HAS);
  });
});

describe("removeMiningSkill", () => {
  it("drops mining, keeping siblings", () => {
    expect(removeMiningSkill(HAS)).toContain("mcpServers: [web-search]");
  });
  it("removes the whole line when mining was the only entry", () => {
    const out = removeMiningSkill(`---\nharness: x\nmcpServers: [mining]\n---\nb\n`);
    expect(out).not.toContain("mcpServers");
  });
  it("is a no-op when mining absent", () => {
    expect(removeMiningSkill(NONE)).toBe(NONE);
  });
});
