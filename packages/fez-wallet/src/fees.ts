import { loadConfig } from "./config.js";
import { buildReceipt } from "./receipt.js";
import { readAgentNostrKey } from "./store.js";
import { alphaPriceTao, formatRao } from "./chains/subtensor.js";
import { signerFromPair, submitAndWait } from "./chains/substrate.js";
import { requirePersonaPair, requireRehearsalNetwork, subtensorFor, DEFAULT_NETUID } from "./stake.js";
import { DEFAULT_MARKET_RELAY, marketPublish } from "./rent.js";
import { requireWalletMutationAllowed } from "./evaluation.js";

/**
 * The fee burn (spec 2026-09-04): skim a small protocol fee off each
 * settlement, accrue it to a dedicated burn vault, and periodically
 * convert the accrued TAO into burned alpha — a market buy the customer
 * never sees, so settlement volume holds alpha's price up without anyone
 * being made to touch the token.
 *
 * The chain answered the spec's load-bearing unknown: subtensor exposes
 * `addStakeBurn(hotkey, netuid, amount, limit)` — TAO in, alpha bought
 * from the pool AND destroyed, one extrinsic. True supply burn, no
 * unspendable-hotkey lock needed.
 *
 * Kill switch, exactly as spec'd: no burn vault derived on this machine
 * (or rate 0) → every split is a no-op and payments flow whole.
 */

/** Start small (spec: 2–3%): a tax on the market we're trying to grow. */
export const FEE_RATE = 0.02;

/** The vault is a persona so every existing rail (derive/status/mirror)
 *  already works on it. Distinct from `treasury` (agent custody) — this
 *  account's only verbs are accrue, buy, burn. */
export const BURN_VAULT = "burnvault";

export function burnVaultAddress(): string | undefined {
  try {
    return requirePersonaPair(BURN_VAULT).address;
  } catch {
    return undefined; // not derived here — fees are OFF on this machine
  }
}

export interface FeeSplit {
  /** What the worker actually receives: amount × (1 − rate). */
  netRao: bigint;
  /** What accrues to the burn vault; 0n when fees are off. */
  feeRao: bigint;
  /** Where the fee goes — present iff feeRao > 0. */
  vault?: string;
}

/** Split a settlement. Disclosed, never silent: callers put netRao on the
 *  receipt so the payout states exactly what the worker got. */
export function splitFee(amountRao: bigint): FeeSplit {
  const vault = burnVaultAddress();
  if (!vault || FEE_RATE <= 0) return { netRao: amountRao, feeRao: 0n };
  const feeRao = (amountRao * BigInt(Math.round(FEE_RATE * 10_000))) / 10_000n;
  // A fee that rounds to zero is zero — don't send dust transfers.
  if (feeRao <= 0n) return { netRao: amountRao, feeRao: 0n };
  return { netRao: amountRao - feeRao, feeRao, vault };
}

export interface BurnStatus {
  vault: string;
  accruedTao: string;
  alphaPriceTao?: number;
}

/** What the till holds, and the pool price it would buy at. */
export async function burnStatus(netuid = DEFAULT_NETUID): Promise<BurnStatus> {
  const pair = requirePersonaPair(BURN_VAULT);
  const config = loadConfig();
  const api = await subtensorFor(config.endpoints.tao);
  const [acct, price] = await Promise.all([
    api.query.system.account(pair.address),
    alphaPriceTao(api, netuid).catch(() => undefined), // the pool read is a courtesy
  ]);
  return { vault: pair.address, accruedTao: formatRao(acct.data.free.toBigInt()), ...(price !== undefined ? { alphaPriceTao: price } : {}) };
}

export interface BurnResult {
  vault: string;
  burnedTao: string;
  txHash: string;
  netuid: number;
  /** The public 47040 announcing this burn on the market relay — the
   *  spec's "publish" step. Absent if the relay was unreachable. */
  receiptId?: string;
}

/** The pallet insists the routed hotkey EXISTS in the hotkey registry
 *  (HotKeyAccountNotExists otherwise), even though burned alpha lands
 *  nowhere — so route through a persona this wallet has registered on
 *  the subnet, read from the public mirror. */
function registeredHotkey(netuid: number): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { homedir } = require("node:os") as typeof import("node:os");
    const state = JSON.parse(readFileSync(`${homedir()}/.fez/extension-data/wallet.json`, "utf8")) as
      { subnet?: Record<string, { netuid?: number; hotkey?: string }> };
    for (const entry of Object.values(state.subnet ?? {})) {
      if (entry.netuid === netuid && entry.hotkey) return entry.hotkey;
    }
  } catch { /* fall through to the sentence below */ }
  throw new Error(`burning routes through a registered hotkey and this wallet has none on netuid ${netuid} — register a persona first (fez-wallet register <persona>)`);
}

/**
 * The scheduled half: spend the vault's accrued TAO on addStakeBurn —
 * alpha bought from this subnet's own AMM and destroyed in the same
 * extrinsic. The chain floor (nominatorMinRequiredStake, 0.01 tТАО)
 * enforces the spec's batch-don't-drip rule for us.
 */
export async function burnRun(amountTao?: string, netuid = DEFAULT_NETUID): Promise<BurnResult> {
  requireWalletMutationAllowed();
  const pair = requirePersonaPair(BURN_VAULT);
  const config = loadConfig();
  requireRehearsalNetwork(config.network);
  const api = await subtensorFor(config.endpoints.tao);
  const free = (await api.query.system.account(pair.address)).data.free.toBigInt();
  const GAS_BUFFER = 5_000_000n; // keep the vault alive to burn another day
  const amountRao = amountTao !== undefined
    ? BigInt(Math.round(Number(amountTao) * 1e9))
    : free > GAS_BUFFER ? free - GAS_BUFFER : 0n;
  if (amountRao <= 0n || amountRao > free) {
    throw new Error(`the vault holds ${formatRao(free)} tTAO — nothing to burn${amountRao > free ? " that large" : ""}`);
  }
  const signer = await signerFromPair(pair);
  const { txHash, blockRef } = await submitAndWait(
    api,
    api.tx.subtensorModule.addStakeBurn(registeredHotkey(netuid), netuid, amountRao, null),
    signer,
    { onTimeout: () => new Error("burn submitted but unconfirmed — check the vault balance before retrying") }
  );
  // The spec's "publish" step: a burn nobody can see is just a claim. A
  // 47040 with memo "burn" (no payee — the money went to nobody, that is
  // the point) rides the market relay; the tx hash makes it checkable
  // on-chain. Best-effort: the alpha is already destroyed.
  let receiptId: string | undefined;
  const nostrKey = readAgentNostrKey(BURN_VAULT);
  if (nostrKey) {
    try {
      const receipt = buildReceipt({
        agentSecretHex: nostrKey,
        amount: { raw: amountRao, decimals: 9, symbol: "TAO" },
        chain: "tao",
        network: config.network,
        txHash,
        blockRef,
        memo: "burn",
      });
      await marketPublish(DEFAULT_MARKET_RELAY, receipt as Parameters<typeof marketPublish>[1]);
      receiptId = receipt.id;
    } catch { /* the burn stands; the counter catches the next one */ }
  }
  return { vault: pair.address, burnedTao: formatRao(amountRao), txHash, netuid, ...(receiptId ? { receiptId } : {}) };
}
