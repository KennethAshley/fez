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
});
