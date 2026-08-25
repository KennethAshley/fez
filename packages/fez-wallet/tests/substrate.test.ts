import { describe, it, expect } from "vitest";
import { parseAmount, formatAmount } from "../src/chains/adapter.js";
import { substrateAdapter, TAO_DECIMALS } from "../src/chains/substrate.js";

describe("amounts", () => {
  it("parses TAO to rao", () => {
    expect(parseAmount("0.5", TAO_DECIMALS, "TAO").raw).toBe(500_000_000n);
    expect(parseAmount("1", TAO_DECIMALS, "TAO").raw).toBe(1_000_000_000n);
  });
  it("rejects garbage", () => {
    expect(() => parseAmount("-1", TAO_DECIMALS, "TAO")).toThrow();
    expect(() => parseAmount("abc", TAO_DECIMALS, "TAO")).toThrow();
    expect(() => parseAmount("0.0000000001", TAO_DECIMALS, "TAO")).toThrow(); // > 9 dp
  });
  it("formats and trims", () => {
    expect(formatAmount({ raw: 500_000_000n, decimals: 9, symbol: "TAO" })).toBe("0.5 TAO");
    expect(formatAmount({ raw: 1_000_000_000n, decimals: 9, symbol: "TAO" })).toBe("1 TAO");
  });
});

describe("substrate adapter (mocked api)", () => {
  const sent: unknown[] = [];
  const fakeApi = {
    query: {
      system: {
        account: async (_addr: string) => ({ data: { free: { toBigInt: () => 2_000_000_000n } } }),
      },
    },
    tx: {
      balances: {
        transferKeepAlive: (to: string, amount: bigint) => ({
          signAndSend: async (_pair: unknown) => {
            sent.push({ to, amount });
            return { toHex: () => "0xdeadbeef" };
          },
        }),
      },
    },
  };
  const adapter = substrateAdapter({
    endpoint: "wss://unused.example",
    apiFactory: async () => fakeApi as never,
  });

  it("reads a balance", async () => {
    const b = await adapter.balance("5Fake", "TAO");
    expect(b.raw).toBe(2_000_000_000n);
    expect(b.symbol).toBe("TAO");
  });

  it("transfers via transferKeepAlive", async () => {
    const pair = { publicKeyHex: "aa", secretKeyHex: "bb", address: "5Fake" };
    const r = await adapter.transfer(pair, "5Dest", { raw: 100n, decimals: 9, symbol: "TAO" });
    expect(r.txHash).toBe("0xdeadbeef");
    expect(sent[0]).toEqual({ to: "5Dest", amount: 100n });
  });

  it("rejects unknown assets", async () => {
    await expect(adapter.balance("5Fake", "DOGE")).rejects.toThrow(/asset/i);
  });
});

import { evmAdapter, NotEnabledError } from "../src/chains/evm.js";

describe("evm stub", () => {
  it("throws NotEnabledError on everything", async () => {
    const evm = evmAdapter();
    expect(() => evm.address({ publicKeyHex: "", secretKeyHex: "", address: "" })).toThrow(NotEnabledError);
    await expect(evm.balance("0x0", "USDC")).rejects.toThrow(NotEnabledError);
  });
});
