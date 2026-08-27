import { describe, it, expect } from "vitest";
import { parseImeta } from "../../fez-client/dist/index.js";
import { attachmentsOf } from "../../../src/agent/media.js";

/**
 * Two imeta parsers, one wire format.
 *
 * `fez-client`'s parseImeta feeds the renderer; core's attachmentsOf feeds
 * the agent. They cannot share code — fez-client has NO dependencies on
 * purpose, the same dependency-light stance that makes its `K` table a
 * mirror of the kind registry rather than an import — so they are held
 * together by a gate instead, exactly as kinds-registry.test.ts holds `K`.
 *
 * Drift here is quiet and lopsided: the same message renders a player for
 * a human while the agent is told there is nothing attached, or the
 * reverse. Whatever one reads out of an imeta tag, the other must read the
 * same, for every field they both carry.
 */

const CASES: { name: string; tags: string[][] }[] = [
  { name: "url and mime", tags: [["imeta", "url https://b.example/a", "m image/png"]] },
  { name: "url, mime and size", tags: [["imeta", "url https://b.example/a", "m video/mp4", "size 4096"]] },
  { name: "url only", tags: [["imeta", "url https://b.example/bare"]] },
  { name: "several attachments, in order", tags: [
    ["imeta", "url https://b.example/1", "m image/png"],
    ["imeta", "url https://b.example/2", "m audio/mp4", "size 70000"],
  ] },
  { name: "unknown fields between known ones", tags: [
    ["imeta", "url https://b.example/a", "blurhash", "alt a cat", "m image/webp", "size 12"],
  ] },
  { name: "an imeta with no url describes nothing", tags: [["imeta", "m image/png", "size 10"]] },
  { name: "non-imeta tags are not attachments", tags: [["p", "abc"], ["e", "def"], ["h", "chan1"]] },
  { name: "a zero size is not a size", tags: [["imeta", "url https://b.example/a", "m image/png", "size 0"]] },
  { name: "a junk size is not a size", tags: [["imeta", "url https://b.example/a", "m image/png", "size huge"]] },
];

describe("imeta parsers agree", () => {
  for (const { name, tags } of CASES) {
    it(name, () => {
      const renderer = parseImeta(tags);
      // attachmentsOf also sweeps the body for bare urls; an empty body
      // isolates the imeta half, which is the half they share.
      const agent = attachmentsOf({ content: "", tags });

      expect(agent.map((a) => a.url)).toEqual(renderer.map((m) => m.url));
      expect(agent.map((a) => a.mime)).toEqual(renderer.map((m) => m.mime));
      expect(agent.map((a) => a.size)).toEqual(renderer.map((m) => m.size));
    });
  }

  it("the renderer carries dim, which the agent has no use for", () => {
    // A deliberate asymmetry, stated so it reads as intent rather than
    // drift: dim reserves layout space on screen; an agent has no layout.
    const tags = [["imeta", "url https://b.example/a", "m image/png", "dim 1920x1080"]];
    expect(parseImeta(tags)[0].dim).toBe("1920x1080");
    expect(attachmentsOf({ content: "", tags })[0]).not.toHaveProperty("dim");
  });
});
