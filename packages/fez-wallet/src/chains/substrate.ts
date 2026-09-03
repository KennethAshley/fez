import type { ChainAdapter, Amount } from "./adapter.js";
import type { WalletPair } from "../derive.js";
import { hexToU8a } from "@polkadot/util";

export const TAO_DECIMALS = 9;

/** Hard ceiling on the initial connect (finding #3). The default WsProvider
 * retries an unreachable endpoint forever (2.5s backoff), which left
 * ApiPromise.create hanging with no way to fail — a stuck MCP call the
 * agent (and its harness timeout) could never recover from. */
export const CONNECT_TIMEOUT_MS = 15_000;

/** Ceiling on the wait between submission and inclusion. CONNECT_TIMEOUT_MS
 * covers only the connect: once signAndSend has handed the extrinsic to the
 * pool, a socket that dies leaves the callback that never comes, and the
 * MCP call hangs until its harness kills it. Bittensor blocks every ~12s,
 * so ten blocks is generous for inclusion and still finite. */
export const IN_BLOCK_TIMEOUT_MS = 120_000;

/**
 * The failure a transfer timeout is: AMBIGUOUS, not failed. The extrinsic
 * was already broadcast, so it may still be included after we stop
 * listening — and an agent told "it failed" retries, which double-pays.
 * The wallet already refuses to let a failed RECEIPT provoke a retried
 * transfer; the transfer itself gets the same treatment. The wording is
 * the safety mechanism here: it has to be readable by the agent as "do
 * not retry", not as an error to paper over.
 */
export function ambiguousTransferError(to: string, timeoutMs: number): Error {
  return new Error(
    `transfer to ${to} was submitted but not confirmed within ${Math.round(timeoutMs / 1000)}s — ` +
      "it MAY OR MAY NOT have landed on chain. This is NOT a failure: do not retry, and do not " +
      "report it as unsent. Check the destination's balance and this address's recent transfers " +
      "on chain first — a retry could pay twice."
  );
}

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
            status: { isInBlock: boolean; asInBlock: { toHex(): string } };
            dispatchError?: SubstrateDispatchError;
            txHash: { toHex(): string };
          }) => void
        ): Promise<() => void>;
      };
    };
  };
  /** Used only by getTransfer — substrate has no by-hash extrinsic lookup,
   * so verifying a receipt means fetching the block it landed in and
   * scanning its extrinsics for the one that matches. */
  rpc: {
    chain: {
      getBlock(hash: string): Promise<{
        block: {
          extrinsics: Array<{
            hash: { toHex(): string };
            signer: { toString(): string };
            method: { args: unknown[] };
          }>;
        };
      }>;
    };
  };
}

/** A signable extrinsic — the slice both transfer and the subtensor verbs
 * submit through, so there is exactly one inclusion/timeout/dispatch-error
 * discipline in this wallet. */
export interface Submittable {
  signAndSend(
    pair: unknown,
    callback: (result: {
      status: { isInBlock: boolean; asInBlock: { toHex(): string } };
      dispatchError?: SubstrateDispatchError;
      txHash: { toHex(): string };
    }) => void
  ): Promise<() => void>;
}

/** The sr25519 signer for a stored pair — shared by every verb that signs. */
export async function signerFromPair(pair: WalletPair): Promise<unknown> {
  const { Keyring } = await import("@polkadot/keyring");
  return new Keyring({ type: "sr25519" }).addFromPair({
    publicKey: hexToU8a(`0x${pair.publicKeyHex}`),
    secretKey: hexToU8a(`0x${pair.secretKeyHex}`),
  });
}

/**
 * Sign, submit, and wait for inclusion — settled only by a real in-block
 * with no dispatchError, a decoded dispatch error, or the caller's own
 * timeout error (which must read as AMBIGUOUS for anything that moves
 * money: the extrinsic is already broadcast). Extracted from transfer so
 * the subtensor verbs inherit the same discipline instead of a lighter one.
 */
export function submitAndWait(
  api: Pick<SubstrateApi, "registry">,
  tx: Submittable,
  signer: unknown,
  opts: { timeoutMs?: number; onTimeout: () => Error }
): Promise<{ txHash: string; blockRef?: string }> {
  let unsub: (() => void) | undefined;
  let settled = false;
  const timeoutMs = opts.timeoutMs ?? IN_BLOCK_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      unsub?.();
    };
    const timer = setTimeout(() => settle(() => reject(opts.onTimeout())), timeoutMs);
    tx.signAndSend(signer, (r) => {
      if (r.dispatchError) {
        settle(() => reject(new Error(decodeDispatchError(api as SubstrateApi, r.dispatchError!))));
      } else if (r.status.isInBlock) {
        settle(() => resolve({ txHash: r.txHash.toHex(), blockRef: r.status.asInBlock.toHex() }));
      }
    })
      .then((u) => {
        unsub = u;
        if (settled) unsub();
      })
      .catch((e) => settle(() => reject(e)));
  });
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

export async function connectApi(endpoint: string): Promise<SubstrateApi> {
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

export function substrateAdapter(opts: {
  endpoint: string;
  apiFactory?: () => Promise<SubstrateApi>;
  /** Test seam; defaults to IN_BLOCK_TIMEOUT_MS. */
  inBlockTimeoutMs?: number;
}): ChainAdapter {
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
      const signer = await signerFromPair(pair);
      // Settled only by a real inclusion, a decoded dispatch error, or the
      // AMBIGUOUS timeout ("it failed" on a broadcast extrinsic invites a
      // retry that pays twice) — see submitAndWait.
      const timeoutMs = opts.inBlockTimeoutMs ?? IN_BLOCK_TIMEOUT_MS;
      try {
        return await submitAndWait(a, a.tx.balances.transferKeepAlive(to, amount.raw), signer, {
          timeoutMs,
          onTimeout: () => ambiguousTransferError(to, timeoutMs),
        });
      } catch (e) {
        const msg = (e as Error).message;
        // Dispatch errors get the transfer framing; the ambiguous timeout
        // already carries its own wording and must pass through untouched.
        throw msg.includes("MAY OR MAY NOT") ? e : new Error(`transfer failed: ${msg}`);
      }
    },
    async getTransfer(blockRef: string, txHash: string) {
      const a = await api();
      try {
        const block = await a.rpc.chain.getBlock(blockRef);
        for (const ex of block.block.extrinsics) {
          if (ex.hash.toHex() !== txHash) continue;
          const [dest, value] = ex.method.args as [{ toString(): string }, { toString(): string }];
          return {
            from: ex.signer.toString(),
            to: dest.toString(),
            raw: BigInt(value.toString()),
          };
        }
        // The block answered but doesn't hold this extrinsic (pruned
        // content within a retained block, or a bad reference). Still
        // unverifiable, never "invalid" — we have no way to tell a
        // forged txHash from one the node simply can't show us anymore.
        return undefined;
      } catch {
        // Pruned, unreachable, or a block this node never had. The caller
        // must render this as unverifiable — not as a failed check.
        return undefined;
      }
    },
  };
}
