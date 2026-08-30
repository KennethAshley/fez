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

  it("throws on bad base64", () => {
    expect(() => decodePaymentRequired("not valid base64 !!! ###")).toThrow();
  });

  it("throws on base64 that isn't JSON", () => {
    expect(() => decodePaymentRequired(Buffer.from("not json", "utf-8").toString("base64"))).toThrow();
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

  it("throws on an amount above 2**53", () => {
    const tooBig = (2n ** 53n + 1n).toString();
    expect(() => offerUsd({ amount: tooBig } as X402Offer)).toThrow();
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
