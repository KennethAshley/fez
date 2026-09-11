import { expect, it } from "vitest";
import { parseFrontmatter } from "../../../src/identity/personas.js";
import { resolveDeclaredSkills } from "../../../src/extensions/mcp-servers.js";
import { ensureMiningSkill } from "../../fez-mining/src/persona-skill.js";

it("the mining capability attaches from both local-link and published package catalog names", () => {
  for (const existing of ['', 'mcpServers: [mining]\n']) {
    const md=ensureMiningSkill(`---\nharness: claude-code\n${existing}---\nAgent`);
    const parsed=parseFrontmatter(md);
    for (const name of ['mining','fez-mining']) {
      const catalog = {[name]:{command:'node',args:['/installed/mcp.js'],package:'@fezchat/mining'}};
      const {resolved,missing}=resolveDeclaredSkills(catalog,parsed.mcpServers.map(name=>({name,source:parsed.mcpSources[name]})));
      expect(missing).toEqual([]);
      expect(resolved.map(s=>s.key)).toEqual([name]);
    }
  }
});
