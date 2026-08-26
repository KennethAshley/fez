import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { sealContent, parseSealed } from "../../../src/protocol/intents.js";

const sk = generateSecretKey();
const signed = finalizeEvent(
  { kind: 47103, created_at: 1_900_000_000, tags: [["h", "chan1"]], content: "future words" },
  sk
);

describe("sealed intents", () => {
  it("round-trips a signed event", () => {
    const sealed = parseSealed(sealContent(signed));
    expect(sealed).toEqual(signed);
  });

  it("legacy plaintext content parses as undefined", () => {
    expect(parseSealed("remember the milk")).toBeUndefined();
    expect(parseSealed("")).toBeUndefined();
  });

  it("malformed or incomplete sealed payloads parse as undefined", () => {
    expect(parseSealed(JSON.stringify({ sealed: { kind: 47103 } }))).toBeUndefined();
    expect(parseSealed(JSON.stringify({ other: 1 }))).toBeUndefined();
    expect(parseSealed(JSON.stringify({ sealed: null }))).toBeUndefined();
  });
});
