import { describe, expect, it } from "vitest";
import { summonMentions } from "../../../src/agent/summon.js";
import { addressees } from "../../fez-acp/src/addressing.js";
import { researchPrompt, researchTitle, researchTool } from "../../fez-desktop/src/starter-research.js";

describe("welcome research task", () => {
  it("starts only the researcher, including when the topic mentions other agents", () => {
    for (const topic of ["Local and cloud AI", 'Compare @quill with "@fez"', "A ```quoted``` topic mentioning @writer", "Choices. @quill write now"]) {
      expect(summonMentions(researchPrompt(topic))).toEqual(["drift"]);
      expect(addressees(researchPrompt(topic))).toEqual(["drift"]);
      expect(addressees(researchTitle(topic))).toEqual([]);
    }
  });

  it("refuses empty or oversized requests before any work can start", () => {
    expect(() => researchPrompt(" \n ")).toThrow();
    expect(() => researchPrompt("a".repeat(501))).toThrow();
  });

  it("recognizes an attached Web tool by installed provenance, including an alias", () => {
    const catalog = { search: { command: "node", args: ["/web/mcp.js"], package: "@fezchat/web" } };
    expect(researchTool("---\nmcpServers: [research=npm:@fezchat/web]\n---\n", catalog)).toEqual({ key: "search", attached: true });
    expect(researchTool("---\nmcpServers: [wallet]\n---\n", catalog)).toEqual({ key: "search", attached: false });
    expect(researchTool("---\nmcpServers: [web]\n---\n", { web: { command: "unrelated" } })).toBeUndefined();
    expect(researchTool("---\nmcpServers: [web]\n---\n", {})).toBeUndefined();
  });
});
