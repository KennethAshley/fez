import { describe, it, expect } from "vitest";
import { joinChunk } from "../../../src/agent/harness.js";

/**
 * An agent speaks, runs a tool, then speaks again. Both utterances are
 * `agent_message_chunk`s and the turn loop accumulated them with a bare
 * `text += chunk`, so the two ran together with nothing between them:
 *
 *   "…sending the 0.005 to quill now.Sent — 0.005 TAO to quill (…)"
 *
 * A tool call between two utterances is a paragraph boundary. Inside one
 * uninterrupted utterance it is not — chunks there are mid-word splits
 * of a single stream and must still concatenate exactly.
 */
describe("joining message chunks across a tool call", () => {
  it("breaks the paragraph when a tool call came between two utterances", () => {
    const before = "Balance is 1.0245 TAO. Sending the 0.005 to quill now.";
    const after = "Sent — 0.005 TAO to quill.";
    expect(joinChunk(before, after, true)).toBe(`${before}\n\n${after}`);
  });

  it("never glues two sentences together", () => {
    const joined = joinChunk("…to quill now.", "Sent — 0.005 TAO", true);
    expect(joined).not.toContain("now.Sent");
  });

  it("concatenates verbatim inside one utterance — chunks split mid-word", () => {
    expect(joinChunk("Bal", "ance is 1.0245 TAO", false)).toBe("Balance is 1.0245 TAO");
  });

  it("does not open with a blank line when the tool call came first", () => {
    expect(joinChunk("", "Sent — 0.005 TAO.", true)).toBe("Sent — 0.005 TAO.");
  });

  it("does not stack breaks on text that already ended in one", () => {
    expect(joinChunk("A paragraph.\n\n", "The next one.", true)).toBe("A paragraph.\n\nThe next one.");
  });

  it("does not leave a dangling break when the chunk is only whitespace", () => {
    expect(joinChunk("Some text.", "   ", true)).toBe("Some text.   ");
  });
});

/**
 * The rule above is only worth anything if the turn loop applies it —
 * this drives the real loop and asserts on the text it publishes.
 */
import { drivePrompt } from "../../../src/agent/harness.js";

function session(messages: unknown[]) {
  let i = 0;
  return {
    prompt: () => new Promise<never>(() => {}), // resolves via the stop below
    nextUpdate: () => Promise.resolve(messages[i++]),
  };
}
const say = (text: string) => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const tool = (toolCallId: string) => ({ update: { sessionUpdate: "tool_call", toolCallId, title: "transfer", status: "pending" } });
const tick = (toolCallId: string) => ({ update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" } });
const stop = { kind: "stop", stopReason: "end_turn" };

describe("the turn loop applies the rule", () => {
  it("separates what the agent said before a tool from what it said after", async () => {
    const out = await drivePrompt(
      session([say("Sending the 0.005 to quill now."), tool("t1"), tick("t1"), say("Sent — 0.005 TAO to quill."), stop]),
      "test", "go"
    );
    expect(out).not.toContain("now.Sent");
    expect(out).toBe("Sending the 0.005 to quill now.\n\nSent — 0.005 TAO to quill.");
  });

  it("leaves a single uninterrupted utterance exactly as streamed", async () => {
    const out = await drivePrompt(session([say("Balance is "), say("1.0245 TAO."), stop]), "test", "go");
    expect(out).toBe("Balance is 1.0245 TAO.");
  });

  it("does not break a paragraph for a running tool's progress ticks", async () => {
    const out = await drivePrompt(session([tool("t1"), say("Checking"), tick("t1"), say(" the balance."), stop]), "test", "go");
    expect(out).toBe("Checking the balance.");
  });
});
