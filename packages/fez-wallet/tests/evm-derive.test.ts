import { describe, it, expect } from "vitest";
import { deriveAgentEvm } from "../src/derive.js";

const JUNK = "test test test test test test test test test test test junk";

describe("EVM derivation", () => {
  it("derives the standard BIP44 account (known vector)", () => {
    const p = deriveAgentEvm(JUNK, 0);
    expect(p.addressHex).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });
  it("is deterministic and index-distinct", () => {
    expect(deriveAgentEvm(JUNK, 1).addressHex).toBe(deriveAgentEvm(JUNK, 1).addressHex);
    expect(deriveAgentEvm(JUNK, 1).addressHex).not.toBe(deriveAgentEvm(JUNK, 0).addressHex);
  });
  it("rejects an invalid mnemonic", () => {
    expect(() => deriveAgentEvm("not a mnemonic", 0)).toThrow();
  });
});
