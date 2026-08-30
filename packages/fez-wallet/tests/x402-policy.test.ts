import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodePaymentRequired,
  pickOffer,
  offerUsd,
  todaySpend,
  recordSpend,
  type X402Offer,
} from "../src/x402.js";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

const SPEC_EXAMPLE = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: "https://example.com/thing", description: "a thing", mimeType: "application/json" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x2096000000000000000000000000000000000001",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

describe("decodePaymentRequired", () => {
  it("decodes the spec's example header shape", () => {
    const decoded = decodePaymentRequired(b64(SPEC_EXAMPLE));
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0].scheme).toBe("exact");
    expect(decoded.accepts[0].amount).toBe("10000");
    expect(decoded.resource?.url).toBe("https://example.com/thing");
  });

  it("tolerates unknown extra fields", () => {
    const decoded = decodePaymentRequired(b64({ ...SPEC_EXAMPLE, weirdFutureField: 42 }));
    expect(decoded.accepts).toHaveLength(1);
  });

  it("garbage base64 surfaces as the JSON-decode error (Buffer.from never throws on bad base64)", () => {
    expect(() => decodePaymentRequired("not valid base64 !!! ###")).toThrow(/did not decode to JSON/);
  });

  it("throws on base64 that isn't JSON", () => {
    expect(() => decodePaymentRequired(Buffer.from("not json", "utf-8").toString("base64"))).toThrow(
      /did not decode to JSON/,
    );
  });

  it("throws when accepts is missing", () => {
    expect(() => decodePaymentRequired(b64({ x402Version: 2 }))).toThrow(/accepts/);
  });

  it("throws when accepts is not an array", () => {
    expect(() => decodePaymentRequired(b64({ accepts: "nope" }))).toThrow(/accepts/);
  });
});

describe("pickOffer", () => {
  const pin = { network: "eip155:84532", usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
  const goodOffer: X402Offer = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0xabc",
  };

  it("picks the matching offer", () => {
    expect(pickOffer([goodOffer], pin)).toBe(goodOffer);
  });

  it("matches the pinned asset case-insensitively", () => {
    const lower = { ...goodOffer, asset: goodOffer.asset.toLowerCase() };
    expect(pickOffer([lower], pin)).toBe(lower);
  });

  it("refuses scheme:permit", () => {
    const permit = { ...goodOffer, scheme: "permit" };
    expect(pickOffer([permit], pin)).toBeUndefined();
  });

  it("refuses a wrong eip155 chain id", () => {
    const wrongChain = { ...goodOffer, network: "eip155:1" };
    expect(pickOffer([wrongChain], pin)).toBeUndefined();
  });

  it("refuses a non-pinned asset", () => {
    const wrongAsset = { ...goodOffer, asset: "0x0000000000000000000000000000000000dEaD" };
    expect(pickOffer([wrongAsset], pin)).toBeUndefined();
  });

  it("returns undefined when no offers match", () => {
    expect(pickOffer([], pin)).toBeUndefined();
  });

  it("matches a mixed-case pinned usdcAddress against a lowercase offer asset", () => {
    const mixedCasePin = { ...pin, usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
    const lowerOffer = { ...goodOffer, asset: goodOffer.asset.toLowerCase() };
    expect(pickOffer([lowerOffer], mixedCasePin)).toBe(lowerOffer);
  });

  it("refuses a network with a trailing near-miss character", () => {
    const suffixed = { ...goodOffer, network: "eip155:84532x" };
    expect(pickOffer([suffixed], pin)).toBeUndefined();
  });

  it("refuses mainnet (eip155:8453) when pinned to base-sepolia (eip155:84532)", () => {
    const mainnet = { ...goodOffer, network: "eip155:8453" };
    expect(pickOffer([mainnet], pin)).toBeUndefined();
  });

  it("refuses a network with a leading space", () => {
    const spaced = { ...goodOffer, network: " eip155:84532" };
    expect(pickOffer([spaced], pin)).toBeUndefined();
  });
});

describe("offerUsd", () => {
  it("converts atomic USDC units to dollars", () => {
    expect(offerUsd({ amount: "10000" } as X402Offer)).toBe(0.01);
  });

  it("throws on a negative amount", () => {
    expect(() => offerUsd({ amount: "-1" } as X402Offer)).toThrow();
  });

  it("throws on a non-numeric amount", () => {
    expect(() => offerUsd({ amount: "not-a-number" } as X402Offer)).toThrow();
  });

  it("throws on a hex amount (BigInt would otherwise silently accept it)", () => {
    expect(() => offerUsd({ amount: "0x10" } as X402Offer)).toThrow(/not a decimal integer string/);
  });

  it("throws on an empty amount (BigInt('') === 0n otherwise)", () => {
    expect(() => offerUsd({ amount: "" } as X402Offer)).toThrow(/not a decimal integer string/);
  });

  it("throws on an amount above 2**53", () => {
    const tooBig = (2n ** 53n + 1n).toString();
    expect(() => offerUsd({ amount: tooBig } as X402Offer)).toThrow();
  });

  it("allows the exact 2**53 boundary (throws only when strictly greater)", () => {
    const boundary = (2n ** 53n).toString();
    expect(offerUsd({ amount: boundary } as X402Offer)).toBeCloseTo(Number(2n ** 53n) / 1e6);
  });
});

describe("daily tally", () => {
  function withTempDir(fn: (dir: string) => void) {
    const dir = mkdtempSync(path.join(tmpdir(), "x402-tally-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reads zero for a fresh dir", () => {
    withTempDir((dir) => {
      expect(todaySpend(dir)).toBe(0);
    });
  });

  it("accumulates within the same day", () => {
    withTempDir((dir) => {
      recordSpend(dir, 0.01);
      recordSpend(dir, 0.02);
      expect(todaySpend(dir)).toBeCloseTo(0.03);
    });
  });

  it("rolls over to zero on a new day", () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, "x402-spend.json"), JSON.stringify({ day: "2020-01-01", usd: 5 }));
      expect(todaySpend(dir)).toBe(0);
    });
  });

  it("treats a corrupt file as zero spent (fail-open)", () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, "x402-spend.json"), "{ not json");
      expect(todaySpend(dir)).toBe(0);
    });
  });

  it("treats a missing file as zero spent", () => {
    withTempDir((dir) => {
      expect(todaySpend(dir)).toBe(0);
    });
  });
});
