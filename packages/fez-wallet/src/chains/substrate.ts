import type { ChainAdapter, Amount } from "./adapter.js";
import type { WalletPair } from "../derive.js";
import { hexToU8a } from "@polkadot/util";

export const TAO_DECIMALS = 9;

/** Hard ceiling on the initial connect (finding #3). The default WsProvider
 * retries an unreachable endpoint forever (2.5s backoff), which left
 * ApiPromise.create hanging with no way to fail — a stuck MCP call the
 * agent (and its harness timeout) could never recover from. */
export const CONNECT_TIMEOUT_MS = 15_000;

/** A dispatch-level failure surfaced by signAndSend's callback — module
 * errors decode through the api's registry; anything else falls back to
 * its own toString(). */
export interface SubstrateDispatchError {
  isModule: boolean;
  asModule: unknown;
  toString(): string;
}

/** The slice of ApiPromise we use — narrow on purpose so tests can fake it. */
export interface SubstrateApi {
  registry: {
    findMetaError(errorIndex: unknown): { section: string; name: string; docs: string[] };
  };
  query: { system: { account(addr: string): Promise<{ data: { free: { toBigInt(): bigint } } }> } };
  tx: {
    balances: {
      transferKeepAlive(
        to: string,
        amount: bigint
      ): {
        signAndSend(
          pair: unknown,
          callback: (result: {
            status: { isInBlock: boolean };
            dispatchError?: SubstrateDispatchError;
            txHash: { toHex(): string };
          }) => void
        ): Promise<() => void>;
      };
    };
  };
}

function decodeDispatchError(api: SubstrateApi, err: SubstrateDispatchError): string {
  if (err.isModule) {
    try {
      const decoded = api.registry.findMetaError(err.asModule);
      return `${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`;
    } catch {
      // fall through to the generic string form below
    }
  }
  return err.toString();
}

/** Races any "ready" promise against a hard ceiling, throwing a uniform,
 * endpoint-naming error if the ceiling wins first. Split out from
 * connectApi() so the timeout behavior is unit-testable without a real
 * WsProvider (see tests/substrate.test.ts). */
export async function raceConnect<T>(ready: Promise<T>, endpoint: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`chain unreachable at ${endpoint}`)), timeoutMs);
  });
  try {
    return await Promise.race([ready, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function connectApi(endpoint: string): Promise<SubstrateApi> {
  // Lazy heavy import — the MCP handshake must answer instantly (same
  // reasoning as fez-bittensor's chain()).
  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  // autoConnect disabled (the `false` second arg): a dead endpoint fails
  // once instead of retrying with an internal 2.5s backoff forever.
  const provider = new WsProvider(endpoint, false);
  try {
    await provider.connect();
    await raceConnect(provider.isReady, endpoint);
    return (await ApiPromise.create({
      provider,
      throwOnConnect: true,
      noInitWarn: true,
    })) as unknown as SubstrateApi;
  } catch {
    // Release the half-open socket — with the memo cleared on failure,
    // each retry would otherwise abandon one provider (final review).
    provider.disconnect().catch(() => {});
    throw new Error(`chain unreachable at ${endpoint}`);
  }
}

export function substrateAdapter(opts: { endpoint: string; apiFactory?: () => Promise<SubstrateApi> }): ChainAdapter {
  let apiPromise: Promise<SubstrateApi> | undefined;
  const api = () => {
    if (!apiPromise) {
      apiPromise = (opts.apiFactory ? opts.apiFactory() : connectApi(opts.endpoint)).catch((e) => {
        // A failed connect must not poison every call after it — clear
        // the memo so the next call gets a fresh attempt (finding #4).
        apiPromise = undefined;
        throw e;
      });
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

      // signAndSend's promise resolves at pool SUBMISSION, not at dispatch
      // (finding #5) — a hash back then meant "accepted for broadcast",
      // not "sent". The callback form is the only place dispatch errors
      // (e.g. existential-deposit) surface, so that's what settles this
      // promise: a real inclusion with no dispatchError, or a rejection
      // with the decoded error — never a hash on the failure path.
      let unsub: (() => void) | undefined;
      let settled = false;
      return new Promise<{ txHash: string }>((resolve, reject) => {
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
          unsub?.();
        };
        a.tx.balances
          .transferKeepAlive(to, amount.raw)
          .signAndSend(signer, (r) => {
            if (r.dispatchError) {
              settle(() => reject(new Error(`transfer failed: ${decodeDispatchError(a, r.dispatchError!)}`)));
            } else if (r.status.isInBlock) {
              settle(() => resolve({ txHash: r.txHash.toHex() }));
            }
          })
          .then((u) => {
            unsub = u;
            if (settled) unsub(); // callback already fired before we got the unsub back
          })
          .catch(reject);
      });
    },
  };
}
