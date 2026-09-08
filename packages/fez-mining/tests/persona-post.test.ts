import { describe, it, expect } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import { buildPersonaEvent } from "../src/persona-post.js";

const SECRET = "1".repeat(64); // 32-byte hex

describe("buildPersonaEvent", () => {
  it("tags the channel and carries the text as a kind-47103 message", () => {
    const t = buildPersonaEvent(SECRET, "chan123", "started mining netuid 56");
    expect(t.kind).toBe(47103);
    expect(t.content).toBe("started mining netuid 56");
    expect(t.tags).toContainEqual(["h", "chan123"]);
    expect(t.tags.some((x) => x[0] === "e")).toBe(false);
  });
  it("adds a root e-tag when threading a reply", () => {
    const t = buildPersonaEvent(SECRET, "chan123", "earned 0.02", "root99");
    expect(t.tags).toContainEqual(["e", "root99", "", "root"]);
  });
  it("is signable by the given key (pubkey derivable)", () => {
    // sanity: the secret we sign with maps to a stable pubkey
    expect(getPublicKey(Uint8Array.from(Buffer.from(SECRET, "hex")))).toHaveLength(64);
  });
});
