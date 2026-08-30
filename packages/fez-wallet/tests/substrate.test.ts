import { describe, it, expect } from "vitest";
import { parseAmount, formatAmount } from "../src/chains/adapter.js";
import { substrateAdapter, TAO_DECIMALS, raceConnect, ambiguousTransferError } from "../src/chains/substrate.js";

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
  function fakeApiWithResults(
    results: Array<{ isInBlock: boolean; dispatchError?: unknown; inBlockHash?: string }>,
    txHash = "0xdeadbeef"
  ) {
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
              cb: (r: {
                status: { isInBlock: boolean; asInBlock: { toHex(): string } };
                dispatchError?: unknown;
                txHash: { toHex(): string };
              }) => void
            ) => {
              sent.push({ to, amount });
              for (const r of results) {
                cb({
                  status: { isInBlock: r.isInBlock, asInBlock: { toHex: () => r.inBlockHash ?? "0xblock" } },
                  dispatchError: r.dispatchError,
                  txHash: { toHex: () => txHash },
                });
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

  it("returns the block hash it landed in", async () => {
    const pair = { publicKeyHex: "aa", secretKeyHex: "bb", address: "5Fake" };
    const blockAdapter = substrateAdapter({
      endpoint: "ws://fake",
      apiFactory: async () => fakeApiWithResults([{ isInBlock: true, inBlockHash: "0xblock" }], "0xtx") as never,
    });
    const result = await blockAdapter.transfer(pair, "5Dest", { raw: 1n, decimals: 9, symbol: "TAO" });
    expect(result).toEqual({ txHash: "0xtx", blockRef: "0xblock" });
  });
});

describe("submitted but never included (finding #3)", () => {
  // A pool that accepted the extrinsic and then went quiet: signAndSend
  // resolved, no status callback ever fires. Without a ceiling this hangs
  // the MCP call forever; with one, the ONLY safe report is ambiguous.
  function silentApi() {
    return {
      tx: {
        balances: {
          transferKeepAlive: () => ({
            signAndSend: async () => () => {}, // accepted for broadcast, then silence
          }),
        },
      },
    };
  }

  it("times out instead of hanging, and says the transfer may have landed", async () => {
    const adapter = substrateAdapter({
      endpoint: "ws://fake",
      apiFactory: async () => silentApi() as never,
      inBlockTimeoutMs: 20,
    });
    const pair = { publicKeyHex: "aa", secretKeyHex: "bb", address: "5Fake" };
    const err = await adapter
      .transfer(pair, "5Dest", { raw: 100n, decimals: 9, symbol: "TAO" })
      .then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // Ambiguity is the point: an agent told "failed" retries, and a retry
    // on an extrinsic that did land pays twice.
    expect(err!.message).toMatch(/MAY OR MAY NOT/);
    expect(err!.message).toMatch(/do not retry/i);
    expect(err!.message).toContain("5Dest");
    expect(err!.message).not.toMatch(/^transfer failed/);
  });

  it("names the ambiguity in seconds", () => {
    expect(ambiguousTransferError("5Dest", 120_000).message).toContain("120s");
  });
});

describe("substrate adapter — block lookup (getTransfer)", () => {
  // A minimal fake exposing only the rpc.chain.getBlock slice getTransfer
  // needs — extrinsics carry a hash, a signer, and decoded call args
  // shaped like real polkadot Codec objects (toHex()/toString()).
  function fakeApiWithBlock(opts: {
    blockHash: string;
    extrinsics: Array<{ hash: string; signer: string; args: [string, bigint] }>;
  }) {
    return {
      rpc: {
        chain: {
          getBlock: async (hash: string) => {
            if (hash !== opts.blockHash) throw new Error("no such block");
            return {
              block: {
                extrinsics: opts.extrinsics.map((ex) => ({
                  hash: { toHex: () => ex.hash },
                  signer: { toString: () => ex.signer },
                  method: {
                    args: [{ toString: () => ex.args[0] }, { toString: () => ex.args[1].toString() }],
                  },
                })),
              },
            };
          },
        },
      },
    };
  }

  it("finds a transfer in its block and reports from/to/amount", async () => {
    const adapter = substrateAdapter({
      endpoint: "ws://fake",
      apiFactory: async () =>
        fakeApiWithBlock({
          blockHash: "0xblock",
          extrinsics: [{ hash: "0xtx", signer: "5From", args: ["5To", 5_000_000n] }],
        }) as never,
    });
    expect(await adapter.getTransfer!("0xblock", "0xtx")).toEqual({
      from: "5From",
      to: "5To",
      raw: 5_000_000n,
    });
  });

  it("returns undefined when the block no longer has the extrinsic", async () => {
    const adapter = substrateAdapter({
      endpoint: "ws://fake",
      apiFactory: async () => fakeApiWithBlock({ blockHash: "0xblock", extrinsics: [] }) as never,
    });
    expect(await adapter.getTransfer!("0xblock", "0xtx")).toBeUndefined();
  });

  it("returns undefined (unverifiable, not invalid) when the node can't look up the block", async () => {
    const adapter = substrateAdapter({
      endpoint: "ws://fake",
      apiFactory: async () => fakeApiWithBlock({ blockHash: "0xblock", extrinsics: [] }) as never,
    });
    expect(await adapter.getTransfer!("0xnotfound", "0xtx")).toBeUndefined();
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

// evm adapter behavior (address/balance live, transfer gated) is covered by
// tests/evm-adapter.test.ts now that address()/balance() are implemented.
