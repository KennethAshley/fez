import type { ChainAdapter, Amount } from "./adapter.js";
import type { WalletPair } from "../derive.js";
import { hexToU8a } from "@polkadot/util";

export const TAO_DECIMALS = 9;

/** The slice of ApiPromise we use — narrow on purpose so tests can fake it. */
export interface SubstrateApi {
  query: { system: { account(addr: string): Promise<{ data: { free: { toBigInt(): bigint } } }> } };
  tx: {
    balances: {
      transferKeepAlive(to: string, amount: bigint): {
        signAndSend(pair: unknown): Promise<{ toHex(): string }>;
      };
    };
  };
}

export function substrateAdapter(opts: {
  endpoint: string;
  apiFactory?: () => Promise<SubstrateApi>;
}): ChainAdapter {
  let apiPromise: Promise<SubstrateApi> | undefined;
  const api = () => {
    if (!apiPromise) {
      apiPromise = opts.apiFactory
        ? opts.apiFactory()
        : // Lazy heavy import — the MCP handshake must answer instantly
          // (same reasoning as fez-bittensor's chain()).
          import("@polkadot/api").then(({ ApiPromise, WsProvider }) =>
            ApiPromise.create({ provider: new WsProvider(opts.endpoint), noInitWarn: true }) as unknown as Promise<SubstrateApi>
          );
    }
    return apiPromise;
  };

  const requireTao = (asset: string) => {
    if (asset !== "TAO") throw new Error(`unknown asset "${asset}" on tao chain`);
  };

  return {
    chain: "tao",
    assets: [{ symbol: "TAO", decimals: TAO_DECIMALS }],
    address: (pair: WalletPair) => pair.address,
    async balance(address: string, asset: string): Promise<Amount> {
      requireTao(asset);
      const a = await api();
      const acct = await a.query.system.account(address);
      return { raw: acct.data.free.toBigInt(), decimals: TAO_DECIMALS, symbol: "TAO" };
    },
    async transfer(pair: WalletPair, to: string, amount: Amount) {
      requireTao(amount.symbol);
      const a = await api();
      const { Keyring } = await import("@polkadot/keyring");
      const signer = new Keyring({ type: "sr25519" }).addFromPair({
        publicKey: hexToU8a(`0x${pair.publicKeyHex}`),
        secretKey: hexToU8a(`0x${pair.secretKeyHex}`),
      });
      const hash = await a.tx.balances.transferKeepAlive(to, amount.raw).signAndSend(signer);
      return { txHash: hash.toHex() };
    },
  };
}
