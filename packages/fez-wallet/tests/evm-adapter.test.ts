import { describe, it, expect } from "vitest";
import { custom } from "viem";
import { evmAdapter, NotEnabledError, type EvmWalletPair } from "../src/chains/evm.js";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PAIR: EvmWalletPair = {
  publicKeyHex: "aa",
  secretKeyHex: "bb",
  address: "5SomeSs58Address",
  evm: { addressHex: ADDRESS, privateKeyHex: "0xdeadbeef" },
};

// A canned JSON-RPC transport — no network call ever leaves this process.
// balanceOf(address) returns 5_000_000 (padded to 32 bytes), USDC has 6 decimals.
const mockTransport = custom({
  async request({ method }: { method: string }) {
    if (method === "eth_call") {
      return "0x" + (5_000_000n).toString(16).padStart(64, "0");
    }
    if (method === "eth_chainId") return "0x14a34"; // base-sepolia
    throw new Error(`unexpected RPC method ${method}`);
  },
});

describe("evmAdapter", () => {
  it("address() echoes the pair's EVM address", () => {
    const a = evmAdapter({ transport: mockTransport });
    expect(a.address(PAIR)).toBe(ADDRESS);
  });

  it("balance() reads USDC via the injected transport, no live chain call", async () => {
    const a = evmAdapter({ transport: mockTransport });
    const b = await a.balance(a.address(PAIR), "USDC");
    expect(b).toEqual({ raw: 5_000_000n, decimals: 6, symbol: "USDC" });
  });

  it("transfer stays gated", async () => {
    const a = evmAdapter({ transport: mockTransport });
    await expect(a.transfer(PAIR, ADDRESS, { raw: 1n, decimals: 6, symbol: "USDC" })).rejects.toBeInstanceOf(
      NotEnabledError
    );
  });

  // I4/M6: a mainnet flip must not keep reading the Sepolia contract.
  it("balance() reads the configured usdcAddress, not the sepolia default", async () => {
    const customUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    let sawAddress: string | undefined;
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_call") {
          sawAddress = (params?.[0] as { to?: string })?.to;
          return "0x" + (1_000_000n).toString(16).padStart(64, "0");
        }
        if (method === "eth_chainId") return "0x2105"; // base mainnet
        throw new Error(`unexpected RPC method ${method}`);
      },
    });
    const a = evmAdapter({ transport, usdcAddress: customUsdc });
    await a.balance(ADDRESS, "USDC");
    expect(sawAddress?.toLowerCase()).toBe(customUsdc.toLowerCase());
  });

  // I5: a pre-EVM stored pair (no `.evm` branch) must not crash raw.
  it("address() throws a friendly error when the pair has no .evm branch", () => {
    const a = evmAdapter({ transport: mockTransport });
    const preEvmPair = { publicKeyHex: "aa", secretKeyHex: "bb", address: "5X" } as EvmWalletPair;
    expect(() => a.address(preEvmPair)).toThrow(/fez-wallet derive/);
  });
});
