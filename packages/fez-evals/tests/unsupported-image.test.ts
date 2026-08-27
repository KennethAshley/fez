import { describe, it, expect } from "vitest";
import { isUnsupportedImageError, drivePrompt } from "../../../src/agent/harness.js";

/**
 * Not every model has eyes.
 *
 * fez hands attached images to whatever model backs the persona as ACP
 * image blocks. A text-only model — a chutes-hosted GLM, a small local
 * one — refuses the request outright, and the refusal is not transient:
 * the image is still in the turn, so every retry fails identically and
 * the turn wedges until something gives up. Buzz names the same failure
 * (buzz-agent/src/llm.rs is_unsupported_image_input_error) and recovers
 * the same way: drop the images, say so in-band, continue the turn.
 */

describe("isUnsupportedImageError", () => {
  it("matches the refusals seen from real providers", () => {
    expect(isUnsupportedImageError(new Error("No endpoints found that support image input"))).toBe(true);
    expect(isUnsupportedImageError(new Error(`"crusoeai/GLM-5.2-NVFP4 is not a multimodal model"`))).toBe(true);
    expect(isUnsupportedImageError("400: this model does not support image input")).toBe(true);
  });

  it("stays tight — a generic failure is NOT an image problem", () => {
    // Dropping images for an error that images did not cause mutates the
    // turn for nothing and hides the real fault.
    expect(isUnsupportedImageError(new Error("400 Bad Request"))).toBe(false);
    expect(isUnsupportedImageError(new Error("API Error: 401"))).toBe(false);
    expect(isUnsupportedImageError(new Error("overloaded"))).toBe(false);
    expect(isUnsupportedImageError(undefined)).toBe(false);
  });
});

/**
 * A fake ACP session, scripted per prompt call.
 *
 * A step that rejects yields NO updates ever after — which is what a real
 * provider refusal looks like from here: the request never became a turn,
 * so nothing will arrive on the update channel. A fake that helpfully
 * returned a stop frame would let the turn "succeed" with empty text and
 * hide exactly the bug under test.
 */
function fakeSession(script: ((input: unknown) => unknown)[] | { reject?: string; updates?: unknown[] }[]) {
  const prompts: unknown[] = [];
  let queue: unknown[] = [];
  let dead = false;
  const steps = script as { reject?: string; updates?: unknown[] }[];
  return {
    prompts,
    session: {
      prompt: async (input: unknown) => {
        prompts.push(input);
        const step = steps[prompts.length - 1];
        if (!step) throw new Error(`unexpected prompt #${prompts.length}`);
        queue = [...(step.updates ?? [])];
        if (step.reject) {
          dead = true;
          throw new Error(step.reject);
        }
        dead = false;
        return undefined;
      },
      nextUpdate: async (): Promise<unknown> => {
        if (queue.length) return queue.shift();
        // Nothing scripted: hang. The caller's own timeout or the prompt
        // rejection decides the turn, never this stub.
        return new Promise(() => {});
      },
    },
    get dead() {
      return dead;
    },
  };
}

const textChunk = (text: string) => ({
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const stop = { kind: "stop", stopReason: "end_turn" };

describe("drivePrompt image recovery", () => {
  const images = [{ data: "aGk=", mimeType: "image/png" }];
  const timeouts = { idleMs: 2_000, maxMs: 10_000 };

  it("retries without the images and finishes the turn", async () => {
    const { session, prompts } = fakeSession([
      { reject: "is not a multimodal model" },
      { updates: [textChunk("no eyes, but here's an answer"), stop] },
    ]);

    const reply = await drivePrompt(
      session, "pi", "what is in this screenshot?", undefined, undefined, undefined, timeouts, images
    );

    expect(reply).toContain("no eyes");
    expect(prompts).toHaveLength(2);
    // First attempt carried the image blocks.
    expect(JSON.stringify(prompts[0])).toContain("image");
    // The retry carried none, and told the model why.
    expect(JSON.stringify(prompts[1])).not.toContain("image/png");
    expect(String(prompts[1])).toMatch(/does not support image input/i);
  }, 20_000);

  it("does not retry when no images were sent — nothing to drop", async () => {
    const { session, prompts } = fakeSession([{ reject: "is not a multimodal model" }]);
    await expect(
      drivePrompt(session, "pi", "hello", undefined, undefined, undefined, timeouts, undefined)
    ).rejects.toThrow(/multimodal/);
    expect(prompts).toHaveLength(1);
  }, 20_000);

  it("lets an unrelated failure through instead of blaming the image", async () => {
    const { session, prompts } = fakeSession([{ reject: "API Error: 401" }]);
    await expect(
      drivePrompt(session, "pi", "hello", undefined, undefined, undefined, timeouts, images)
    ).rejects.toThrow(/401/);
    expect(prompts).toHaveLength(1);
  }, 20_000);

  it("surfaces the provider's own error text rather than an idle timeout", async () => {
    const { session } = fakeSession([{ reject: "is not a multimodal model" }]);
    await expect(
      drivePrompt(session, "pi", "hello", undefined, undefined, undefined, timeouts, undefined)
    ).rejects.toThrow(/not a multimodal model/);
  }, 20_000);
});
