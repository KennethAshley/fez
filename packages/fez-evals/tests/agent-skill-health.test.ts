import { describe, it, expect } from "vitest";
import { agentSkillHealth } from "../../fez-desktop/src/agent-skill-health.js";

/**
 * The two ways an agent is quietly broken, both live on the author's
 * machine: @researcher declares a github nobody installed, and @scout's
 * two skills point into a working tree that exists on one computer.
 */
describe("agent skill health", () => {
  const catalog = {
    bittensor: { command: "node", args: ["/Users/ken/Projects/fez/packages/fez-bittensor/dist/mcp.js"], package: "@fezchat/bittensor" },
    "web-search": { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], package: "@brave/brave-search-mcp-server" },
  };
  const persona = (skills: string) => `---\nharness: claude-code\nmcpServers: [${skills}]\n---\nbody\n`;

  it("names skills that resolve to nothing", () => {
    expect(agentSkillHealth(persona("web-search, github"), catalog).missing).toEqual(["github"]);
  });

  it("names skills whose command points into a local directory", () => {
    expect(agentSkillHealth(persona("bittensor"), catalog).local).toEqual(["bittensor"]);
  });

  it("a published skill run through npx is not local", () => {
    expect(agentSkillHealth(persona("web-search"), catalog).local).toEqual([]);
  });

  it("a healthy agent reports nothing", () => {
    expect(agentSkillHealth(persona("web-search"), catalog)).toEqual({ missing: [], local: [], missingSkillMds: [] });
  });

  it("an agent declaring no skills reports nothing", () => {
    expect(agentSkillHealth(`---\nharness: pi\n---\nbody\n`, catalog)).toEqual({ missing: [], local: [], missingSkillMds: [] });
  });

  it("a missing skill is not also reported as local", () => {
    const out = agentSkillHealth(persona("github"), catalog);
    expect(out).toEqual({ missing: ["github"], local: [], missingSkillMds: [] });
  });
});
