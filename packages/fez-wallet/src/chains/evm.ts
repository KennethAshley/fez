import type { ChainAdapter, Amount } from "./adapter.js";
import type { WalletPair, EvmPair } from "../derive.js";
import { createPublicClient, http, erc20Abi, type Transport } from "viem";

/** USDC on base-sepolia — the only asset this adapter reads a live balance
 * for today. */
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/** Direct EVM transfers land in a later release. x402 (the next tasks in
 * this plan) pays via signed authorizations (EIP-3009 style), never via
 * adapter.transfer — so this stays gated rather than half-wired. */
export class NotEnabledError extends Error {
  constructor() {
    super("direct evm transfers land in a later release — x402 pays via signed authorizations, not adapter.transfer");
  }
}

/** A pair derived before EVM existed (T1/T2) has no `.evm` branch —
 * `pair.evm.addressHex` would otherwise throw a raw, unhelpful TypeError.
 * Mirrors tools.ts's resolveEvmPair wording; this adapter has no persona
 * name to interpolate (it's a stateless, persona-agnostic singleton), so
 * the message stays generic rather than faking one in. */
export class NoEvmAccountError extends Error {
  constructor() {
    super("no EVM account for this persona yet — re-run `fez-wallet derive <persona>` to add one");
  }
}

/** The pair shape this adapter actually needs: the sr25519 WalletPair plus
 * the EVM branch stored beside it (see derive.ts's cmdDerive / evmPairFromStored). */
export interface EvmWalletPair extends WalletPair {
  evm: EvmPair;
}

export function evmAdapter(
  opts: { rpcUrl?: string; transport?: Transport; usdcAddress?: string } = {}
): ChainAdapter {
  const rpcUrl = opts.rpcUrl ?? "https://sepolia.base.org";
  // A mainnet flip (I4/M6, config.ts's x402Settings) sends its own
  // usdcAddress through here — without this, balanceOf would keep
  // reading the Sepolia contract on Base mainnet, revert, get caught as
  // "balance unverified", and fail the guard OPEN on real money.
  const usdcAddress = (opts.usdcAddress ?? USDC_BASE_SEPOLIA) as `0x${string}`;
  const client = createPublicClient({ transport: opts.transport ?? http(rpcUrl) });

  return {
    chain: "eth",
    assets: [
      { symbol: "ETH", decimals: 18 },
      { symbol: "USDC", decimals: 6 },
    ],
    address: (pair: EvmWalletPair) => {
      if (!pair.evm) throw new NoEvmAccountError();
      return pair.evm.addressHex;
    },
    async balance(address: string, asset: string): Promise<Amount> {
      if (asset !== "USDC") throw new Error(`unknown asset "${asset}" on eth chain`);
      const raw = await client.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      });
      return { raw, decimals: 6, symbol: "USDC" };
    },
    transfer: () => Promise.reject(new NotEnabledError()),
  };
}
