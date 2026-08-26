import type { ChainAdapter } from "./adapter.js";

/** EVM lands in a later release. The stub exists so the adapter registry
 * and agent-facing tools are final today — enabling ETH/USDC will not
 * change any tool signature. */
export class NotEnabledError extends Error {
  constructor() {
    super("evm support lands in a later release");
  }
}

export function evmAdapter(): ChainAdapter {
  const nope = () => Promise.reject(new NotEnabledError());
  return {
    chain: "eth",
    assets: [
      { symbol: "ETH", decimals: 18 },
      { symbol: "USDC", decimals: 6 },
    ],
    address: () => {
      throw new NotEnabledError();
    },
    balance: nope,
    transfer: nope,
  };
}
