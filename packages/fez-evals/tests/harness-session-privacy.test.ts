import { describe, expect, it } from "vitest";
import { acpSessionMeta, harnessMcpServer } from "../../../src/agent/harness.js";

describe("Fez-owned ACP sessions", () => {
  it("keeps Computer use loadable in Claude without renaming the attachment or other harnesses", () => {
    const server = { name: "computer-use", command: "node", args: ["computer-use.mjs"], env: [{ name: "FEZ_AGENT_PERSONA", value: "fez" }] };
    expect(harnessMcpServer("claude-code", server)).toEqual({ ...server, name: "fez-computer-use" });
    expect(server.name).toBe("computer-use");
    expect(harnessMcpServer("pi", server)).toBe(server);
    const ordinary = { ...server, name: "fez" };
    expect(harnessMcpServer("claude-code", ordinary)).toBe(ordinary);
  });

  it.each([undefined, "You are Dubois."])(
    "keeps Claude transcripts out of the user's Claude history",
    (systemPrompt) => {
      const meta = acpSessionMeta("claude-code", systemPrompt);
      expect(meta).toMatchObject({
        claudeCode: { options: { persistSession: false } },
      });
    }
  );

  it("preserves Fez's system prompt metadata", () => {
    expect(acpSessionMeta("claude-code", "You are Dubois.")).toMatchObject({
      "fez/systemPrompt": "You are Dubois.",
    });
  });

  it("does not send Claude-specific options to other ACP harnesses", () => {
    expect(acpSessionMeta("pi", "You are Dubois.")).toEqual({
      "fez/systemPrompt": "You are Dubois.",
    });
  });
});
