import { describe, expect, it } from "vitest";
import { acpSessionMeta } from "../../../src/agent/harness.js";

describe("Fez-owned ACP sessions", () => {
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
