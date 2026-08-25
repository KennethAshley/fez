import { describe, it, expect } from "vitest";
import { parseAmount, formatAmount } from "../src/chains/adapter.js";
import { substrateAdapter, TAO_DECIMALS, raceConnect } from "../src/chains/substrate.js";

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
  // Callback-shaped signAndSend (finding #5) — a real ISubmittableResult
  // stream: one or more status callbacks, settling only on inBlock (with
  // no dispatchError) or on a dispatchError showing up first.
  function fakeApiWithResults(results: Array<{ isInBlock: boolean; dispatchError?: unknown }>) {
    return {
      registry: {
        findMetaError: (_e: unknown) => ({ section: "balances", name: "ExistentialDeposit", docs: ["balance too low"] }),
      },
      query: {
        system: {
          account: async (_addr: string) => ({ data: { free: { toBigInt: () => 2_000_000_000n } } }),
        },
      },
      tx: {
        balances: {
          transferKeepAlive: (to: string, amount: bigint) => ({
            signAndSend: async (
              _pair: unknown,
              cb: (r: { status: { isInBlock: boolean }; dispatchError?: unknown; txHash: { toHex(): string } }) => void
            ) => {
              sent.push({ to, amount });
              for (const r of results) {
                cb({ status: { isInBlock: r.isInBlock }, dispatchError: r.dispatchError, txHash: { toHex: () => "0xdeadbeef" } });
              }
              return () => {};
            },
          }),
        },
      },
    };
  }
  const fakeApi = fakeApiWithResults([{ isInBlock: true }]);
  const adapter = substrateAdapter({
    endpoint: "wss://unused.example",
    apiFactory: async () => fakeApi as never,
  });

  it("reads a balance", async () => {
    const b = await adapter.balance("5Fake", "TAO");
    expect(b.raw).toBe(2_000_000_000n);
    expect(b.symbol).toBe("TAO");
  });

  it("transfers via transferKeepAlive, resolving only once truly in-block", async () => {
    const pair = { publicKeyHex: "aa", secretKeyHex: "bb", address: "5Fake" };
    const r = await adapter.transfer(pair, "5Dest", { raw: 100n, decimals: 9, symbol: "TAO" });
    expect(r.txHash).toBe("0xdeadbeef");
    expect(sent[0]).toEqual({ to: "5Dest", amount: 100n });
  });

  it("rejects unknown assets", async () => {
    await expect(adapter.balance("5Fake", "DOGE")).rejects.toThrow(/asset/i);
  });

  it("a dispatch error rejects the transfer — no false 'sent' hash", async () => {
    const dispatchAdapter = substrateAdapter({
      endpoint: "wss://unused.example",
      apiFactory: async () => fakeApiWithResults([{ isInBlock: true, dispatchError: { isModule: true, asModule: {}, toString: () => "boom" } }]) as never,
    });
    const pair = { publicKeyHex: "aa", secretKeyHex: "bb", address: "5Fake" };
    await expect(
      dispatchAdapter.transfer(pair, "5Dest", { raw: 100n, decimals: 9, symbol: "TAO" })
    ).rejects.toThrow(/ExistentialDeposit|balances\./);
  });

  it("clears the connection memo on a failed connect so the next call retries", async () => {
    let calls = 0;
    const retryAdapter = substrateAdapter({
      endpoint: "wss://unused.example",
      apiFactory: async () => {
        calls++;
        if (calls === 1) throw new Error("connect boom");
        return fakeApi as never;
      },
    });
    await expect(retryAdapter.balance("5Fake", "TAO")).rejects.toThrow("connect boom");
    const b = await retryAdapter.balance("5Fake", "TAO");
    expect(b.raw).toBe(2_000_000_000n);
    expect(calls).toBe(2);
  });
});

describe("raceConnect (finding #3 — unreachable endpoint must not hang forever)", () => {
  it("throws a clean, endpoint-naming error when readiness never resolves", async () => {
    const neverReady = new Promise<never>(() => {}); // simulates a dead endpoint
    await expect(raceConnect(neverReady, "wss://dead.example", 20)).rejects.toThrow(
      /chain unreachable at wss:\/\/dead\.example/
    );
  });

  it("resolves normally when readiness wins the race", async () => {
    await expect(raceConnect(Promise.resolve("ready"), "wss://fine.example", 20)).resolves.toBe("ready");
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
