import type { WalletPair } from "../derive.js";
import {
  connectApi,
  signerFromPair,
  submitAndWait,
  TAO_DECIMALS,
  type SubstrateApi,
  type Submittable,
} from "./substrate.js";

/**
 * The stake rehearsal's chain verbs — register, stake, unstake, status —
 * against bittensor's subtensor pallet. Shapes pinned against the LIVE
 * testnet (2026-09-03, wss://test.finney.opentensor.ai), not docs:
 *
 *   tx.subtensorModule.burnedRegister(netuid: u16, hotkey: AccountId32)
 *   tx.subtensorModule.addStake(hotkey, netuid, amountStaked: u64)      // TAO in, alpha out
 *   tx.subtensorModule.removeStake(hotkey, netuid, amountUnstaked: u64) // alpha units
 *   query.subtensorModule.uids(netuid, hotkey) -> Option<u16>
 *   query.subtensorModule.burn(netuid) -> u64 (rao)
 *   call.stakeInfoRuntimeApi.getStakeInfoForHotkeyColdkeyNetuid(hotkey, coldkey, netuid)
 *
 * Custody stays guardian-shaped (spec 2026-09-03): the treasury coldkey
 * pays the registration burn and owns the uid; the persona's own derived
 * account IS its hotkey and signs its own stake.
 */

/** The pallet slice these verbs touch, in the same narrow-on-purpose style
 * as SubstrateApi — tests can fake it, and drift shows up as a type error. */
export interface SubtensorApi extends SubstrateApi {
  query: SubstrateApi["query"] & {
    subtensorModule: {
      uids(netuid: number, hotkey: string): Promise<{ isSome: boolean; unwrap(): { toNumber(): number } }>;
      burn(netuid: number): Promise<{ toBigInt(): bigint }>;
      owner(hotkey: string): Promise<{ toString(): string }>;
      subnetTAO(netuid: number): Promise<{ toBigInt(): bigint }>;
      subnetAlphaIn(netuid: number): Promise<{ toBigInt(): bigint }>;
    };
  };
  tx: SubstrateApi["tx"] & {
    subtensorModule: {
      burnedRegister(netuid: number, hotkey: string): Submittable;
      addStake(hotkey: string, netuid: number, amountStaked: bigint): Submittable;
      /** TAO in → alpha bought from the subnet pool AND destroyed, one
       *  extrinsic — the fee burn's whole back half (spec 2026-09-04).
       *  `limit` caps the price paid; null = market. */
      addStakeBurn(hotkey: string, netuid: number, amount: bigint, limit: bigint | null): Submittable;
      removeStake(hotkey: string, netuid: number, amountUnstaked: bigint): Submittable;
      transferStake(
        destinationColdkey: string,
        hotkey: string,
        originNetuid: number,
        destinationNetuid: number,
        alphaAmount: bigint
      ): Submittable;
    };
  };
  call: {
    stakeInfoRuntimeApi: {
      getStakeInfoForHotkeyColdkeyNetuid(hotkey: string, coldkey: string, netuid: number): Promise<unknown>;
    };
  };
}

export async function connectSubtensor(endpoint: string): Promise<SubtensorApi> {
  return (await connectApi(endpoint)) as SubtensorApi;
}

/** An extrinsic that never confirmed is AMBIGUOUS, exactly like a transfer:
 * it was broadcast, so a retry may do it twice. Same wording discipline. */
const ambiguous = (what: string) => () =>
  new Error(
    `${what} was submitted but not confirmed — it MAY OR MAY NOT have landed on chain. ` +
      "Do not retry blindly: check with fez-wallet status first."
  );

/** The registered uid for a hotkey on a netuid, or undefined. Pure read. */
export async function uidFor(api: SubtensorApi, netuid: number, hotkey: string): Promise<number | undefined> {
  const uid = await api.query.subtensorModule.uids(netuid, hotkey);
  return uid.isSome ? uid.unwrap().toNumber() : undefined;
}

/** What registration burns right now, in rao — reported before signing
 * (consent, not surprise; the figure moves with demand). */
export async function burnCost(api: SubtensorApi, netuid: number): Promise<bigint> {
  return (await api.query.subtensorModule.burn(netuid)).toBigInt();
}

/** Treasury signs the burn, naming the persona's account as hotkey.
 * Idempotence is the CALLER's job (check uidFor first): the chain refuses
 * a duplicate anyway, but adopt-and-report reads better than an error. */
export async function register(
  api: SubtensorApi,
  treasury: WalletPair,
  hotkey: string,
  netuid: number
): Promise<{ txHash: string; uid?: number }> {
  const signer = await signerFromPair(treasury);
  const { txHash } = await submitAndWait(api, api.tx.subtensorModule.burnedRegister(netuid, hotkey), signer, {
    onTimeout: ambiguous(`registration of ${hotkey} on netuid ${netuid}`),
  });
  return { txHash, uid: await uidFor(api, netuid, hotkey) };
}

/** The persona's own account stakes to its own hotkey. amountRao is TAO. */
export async function addStake(
  api: SubtensorApi,
  persona: WalletPair,
  netuid: number,
  amountRao: bigint
): Promise<{ txHash: string }> {
  const signer = await signerFromPair(persona);
  return submitAndWait(api, api.tx.subtensorModule.addStake(persona.address, netuid, amountRao), signer, {
    onTimeout: ambiguous(`stake of ${formatRao(amountRao)} to ${persona.address}`),
  });
}

/** Symmetric — amountRao here is ALPHA units, what status reports as staked. */
export async function removeStake(
  api: SubtensorApi,
  persona: WalletPair,
  netuid: number,
  amountRao: bigint
): Promise<{ txHash: string }> {
  const signer = await signerFromPair(persona);
  return submitAndWait(api, api.tx.subtensorModule.removeStake(persona.address, netuid, amountRao), signer, {
    onTimeout: ambiguous(`unstake of ${formatRao(amountRao)} from ${persona.address}`),
  });
}

/** Which coldkey owns a hotkey's registration — where the chain credits
 * the hotkey's mining emissions. For a guardian-registered agent this is
 * the treasury, and the gap between this entry and the agent's own is
 * exactly what `payout` exists to close. */
export async function ownerOf(api: SubtensorApi, hotkey: string): Promise<string> {
  return (await api.query.subtensorModule.owner(hotkey)).toString();
}

/**
 * The guardian's sweep: move earned alpha from the OWNING coldkey's stake
 * entry on the agent's hotkey into the agent's own entry — same hotkey,
 * same netuid, only the name on the account changes. Signed by the origin
 * coldkey (the treasury). The alpha stays staked throughout: this is a
 * handoff, never an unstake.
 */
export async function transferStake(
  api: SubtensorApi,
  origin: WalletPair,
  opts: { destinationColdkey: string; hotkey: string; netuid: number; amountRao: bigint }
): Promise<{ txHash: string }> {
  const signer = await signerFromPair(origin);
  return submitAndWait(
    api,
    api.tx.subtensorModule.transferStake(opts.destinationColdkey, opts.hotkey, opts.netuid, opts.netuid, opts.amountRao),
    signer,
    { onTimeout: ambiguous(`stake transfer of ${formatRao(opts.amountRao)} to ${opts.destinationColdkey}`) }
  );
}

/**
 * The staked alpha behind (hotkey, coldkey) on a netuid, in rao-like base
 * units — for self-stake both keys are the persona's address. Read through
 * the runtime api; its exact struct has drifted across subtensor releases,
 * so the fields are fished out defensively: an unreadable answer comes
 * back undefined ("unknown, not zero" — the GUI's honesty rule).
 */
export async function stakedAlpha(
  api: SubtensorApi,
  netuid: number,
  hotkey: string,
  coldkey: string
): Promise<bigint | undefined> {
  try {
    const info = await api.call.stakeInfoRuntimeApi.getStakeInfoForHotkeyColdkeyNetuid(hotkey, coldkey, netuid);
    const json = (info as { toJSON?: () => unknown }).toJSON?.() ?? info;
    if (json === null || typeof json !== "object") return undefined;
    const stake = (json as { stake?: unknown }).stake;
    if (typeof stake === "number" || typeof stake === "string") return BigInt(stake);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * What one alpha fetches in TAO right now, from 553's pool reserves —
 * a VALUATION, not a promise: it moves with every trade and an actual
 * unstake pays slippage this figure ignores. undefined when the pool is
 * empty or the chain won't say — the caller renders nothing rather than
 * a stale or fake number.
 */
export async function alphaPriceTao(api: SubtensorApi, netuid: number): Promise<number | undefined> {
  try {
    const [tao, alphaIn] = await Promise.all([
      api.query.subtensorModule.subnetTAO(netuid),
      api.query.subtensorModule.subnetAlphaIn(netuid),
    ]);
    const a = alphaIn.toBigInt();
    if (a === 0n) return undefined;
    return Number(tao.toBigInt()) / Number(a);
  } catch {
    return undefined;
  }
}

/** Rao → decimal TAO/alpha text, 9 decimals, trailing zeros trimmed. */
export function formatRao(raw: bigint): string {
  const base = 10n ** BigInt(TAO_DECIMALS);
  const frac = (raw % base).toString().padStart(TAO_DECIMALS, "0").replace(/0+$/, "");
  return `${raw / base}${frac ? "." + frac : ""}`;
}
