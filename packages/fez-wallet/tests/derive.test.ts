import { describe, it, expect, beforeAll } from "vitest";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import {
  generateWalletMnemonic,
  deriveAgentPair,
  treasuryPair,
  pairFromStored,
} from "../src/derive.js";

// Substrate's canonical dev mnemonic — public knowledge, safe in tests.
const DEV_MNEMONIC =
  "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

beforeAll(async () => {
  await cryptoWaitReady();
});

describe("derivation", () => {
  it("generates a 24-word mnemonic", () => {
    expect(generateWalletMnemonic().split(" ")).toHaveLength(24);
  });

  it("matches the public //Alice vector (proves sr25519 hard derivation is correct)", () => {
    const alice = deriveAgentPair(DEV_MNEMONIC, "Alice");
    expect(alice.address).toBe("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
  });

  it("is deterministic and persona-distinct", () => {
    const a1 = deriveAgentPair(DEV_MNEMONIC, "scout");
    const a2 = deriveAgentPair(DEV_MNEMONIC, "scout");
    const b = deriveAgentPair(DEV_MNEMONIC, "vault");
    expect(a1.address).toBe(a2.address);
    expect(a1.address).not.toBe(b.address);
    expect(a1.address).not.toBe(treasuryPair(DEV_MNEMONIC).address);
  });

  it("round-trips through stored JSON", () => {
    const p = deriveAgentPair(DEV_MNEMONIC, "scout");
    const back = pairFromStored(JSON.stringify(p));
    expect(back).toEqual(p);
  });

  it("rejects a bad mnemonic", () => {
    expect(() => deriveAgentPair("not a mnemonic at all", "scout")).toThrow();
  });

  it("rejects malformed stored JSON with a generic error that never echoes the input", () => {
    const secret = "correct horse battery staple this-is-not-json";
    try {
      pairFromStored(secret);
      throw new Error("expected pairFromStored to throw");
    } catch (e) {
      expect((e as Error).message).toBe("malformed stored pair");
      expect((e as Error).message).not.toContain("correct horse");
    }
  });

  it("rejects a stored pair missing required fields, generically", () => {
    expect(() => pairFromStored(JSON.stringify({ publicKeyHex: "aa" }))).toThrow("malformed stored pair");
  });
});
