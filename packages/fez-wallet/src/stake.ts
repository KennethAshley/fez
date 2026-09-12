import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { endpointFor } from "./networks.js";
import { readEntry } from "./store.js";
import { pairFromStored } from "./derive.js";
import { isValidEntryName, isReservedEntryName } from "./entry-names.js";
import { loadConfig, type Network } from "./config.js";
import { parseAmount } from "./chains/adapter.js";
import { TAO_DECIMALS } from "./chains/substrate.js";
import {
  addStake, alphaPriceTao, connectSubtensor, formatRao, ownerOf, removeStake, stakedAlpha, uidFor,
  type SubtensorApi,
} from "./chains/subtensor.js";
import { mirrorSubnet } from "./storage-mirror.js";
// Cycle with fees.ts (it needs requirePersonaPair) — safe: both sides
// only call at runtime, never at module top level.
import { splitFee } from "./fees.js";
import { requireWalletMutationAllowed } from "./evaluation.js";

/**
 * The persona-only half of the stake rehearsal: stake, unstake, status.
 *
 * Split out of cli-commands.ts ON PURPOSE — that module owns the root
 * mnemonic, and this one must be importable from mcp.ts, whose import
 * graph never touches readRootEntry (spec invariant 2). Everything here
 * runs on the persona's own derived pair: the agent's earnings, staked
 * behind the agent's name, signed by the agent's key. Registration is
 * NOT here — the treasury signs the burn, and the treasury is the
 * guardian's, so `register` stays a cli-commands verb.
 */

export const DEFAULT_NETUID = 553;

/** One live api per endpoint — an MCP server calling status on every
 * balance check must not leak a websocket per call (the same finding #4
 * substrateAdapter already paid for). A failed connect clears the memo
 * so the next call retries fresh. */
const apis = new Map<string, Promise<SubtensorApi>>();
export function subtensorFor(endpoint: string): Promise<SubtensorApi> {
  let p = apis.get(endpoint);
  if (!p) {
    p = connectSubtensor(endpoint).catch((e) => {
      apis.delete(endpoint);
      throw e;
    });
    apis.set(endpoint, p);
  }
  return p;
}

/** The persona's stored pair, or a plain sentence about what to run first. */
export function requirePersonaPair(persona: string) {
  if (!isValidEntryName(persona) || isReservedEntryName(persona)) {
    throw new Error(`"${persona}" is not a usable persona name`);
  }
  const stored = readEntry(persona);
  if (!stored) throw new Error(`no wallet for "${persona}" — run: fez-wallet derive ${persona}`);
  return pairFromStored(stored);
}

/** The write verbs are testnet-only for now (mainnet enablement is gated on
 * the roadmap's criteria) — refuse finney in a sentence, never silently.
 * ponytail: when mainnet opens, self-stake needs a consent story too. */
export function requireRehearsalNetwork(network: Network, endpoint: string): void {
  if (network !== "test" || endpoint !== endpointFor("test")) {
    throw new Error("wallet writes are testnet-only and require the standard testnet endpoint — switch with: fez-wallet network test");
  }
}

export interface StakeResult {
  persona: string;
  netuid: number;
  txHash: string;
  amount: string;
}

export async function stakePersona(persona: string, amount: string, netuid = DEFAULT_NETUID): Promise<StakeResult> {
  requireWalletMutationAllowed();
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  requireRehearsalNetwork(config.network, config.endpoints.tao);
  const parsed = parseAmount(amount, TAO_DECIMALS, "TAO");
  const api = await subtensorFor(config.endpoints.tao);
  // Balance-checked here for the plain refusal the spec asks for — the
  // chain would refuse too, but "quill has 1.2 tTAO free; staking 5 needs
  // funding first" beats a decoded pallet error.
  const acct = await api.query.system.account(pair.address);
  const free = acct.data.free.toBigInt();
  if (free < parsed.raw) {
    throw new Error(`${persona} has ${formatRao(free)} tTAO free; staking ${amount} needs funding first (fez-wallet fund ${persona} <amt>)`);
  }
  const { txHash } = await addStake(api, pair, netuid, parsed.raw);
  return { persona, netuid, txHash, amount };
}

export async function unstakePersona(persona: string, amount: string, netuid = DEFAULT_NETUID): Promise<StakeResult> {
  requireWalletMutationAllowed();
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  requireRehearsalNetwork(config.network, config.endpoints.tao);
  const parsed = parseAmount(amount, TAO_DECIMALS, "TAO"); // alpha shares TAO's 9 decimals
  const api = await subtensorFor(config.endpoints.tao);
  const staked = await stakedAlpha(api, netuid, pair.address, pair.address);
  if (staked !== undefined && staked < parsed.raw) {
    throw new Error(`${persona} has ${formatRao(staked)} tα staked; unstaking ${amount} is more than that`);
  }
  const { txHash } = await removeStake(api, pair, netuid, parsed.raw);
  return { persona, netuid, txHash, amount };
}

export interface PersonaChainStatus {
  persona: string;
  address: string;
  network: Network;
  netuid: number;
  /** Absent means "not registered"; the GUI's register button keys off it. */
  uid?: number;
  free: string;
  /** Absent means UNKNOWN (chain wouldn't say), never zero. */
  staked?: string;
  /** Alpha the chain has credited to the REGISTERING coldkey's entry on
   * this hotkey — emissions earned but not yet swept to the agent's own
   * name. Absent when the agent owns its own hotkey (nothing to sweep)
   * or the chain wouldn't say. `fez-wallet payout` moves it. */
  earned?: string;
  /** What one alpha fetches in TAO from the subnet pool at read time — a
   * valuation for the ≈ gloss, never a promise (moves with every trade,
   * ignores slippage). Absent when the pool won't say. */
  alphaPriceTao?: number;
}

export async function personaStatus(persona: string, netuid = DEFAULT_NETUID): Promise<PersonaChainStatus> {
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  const api = await subtensorFor(config.endpoints.tao);
  const [uid, acct, staked, price] = await Promise.all([
    uidFor(api, netuid, pair.address),
    api.query.system.account(pair.address),
    stakedAlpha(api, netuid, pair.address, pair.address),
    alphaPriceTao(api, netuid),
  ]);
  // Emissions land under Owner(hotkey) — only a registered hotkey owned by
  // someone OTHER than the agent has a guardian entry to report.
  let earned: bigint | undefined;
  if (uid !== undefined) {
    const owner = await ownerOf(api, pair.address).catch(() => undefined);
    if (owner && owner !== pair.address) {
      earned = await stakedAlpha(api, netuid, pair.address, owner);
    }
  }
  // A wiped testnet must render post-wipe truth: chain says unregistered →
  // the mirror says so too, or the panel keeps offering a dead uid.
  if (uid !== undefined) {
    await mirrorSubnet({
      name: persona,
      entry: {
        netuid,
        uid,
        hotkey: pair.address,
        free: formatRao(acct.data.free.toBigInt()),
        ...(staked !== undefined ? { staked: formatRao(staked) } : {}),
        at: new Date().toISOString(),
      },
    });
  }
  return {
    persona,
    address: pair.address,
    network: config.network,
    netuid,
    ...(uid !== undefined ? { uid } : {}),
    free: formatRao(acct.data.free.toBigInt()),
    ...(staked !== undefined ? { staked: formatRao(staked) } : {}),
    ...(earned !== undefined ? { earned: formatRao(earned) } : {}),
    ...(price !== undefined ? { alphaPriceTao: price } : {}),
  };
}

/* ── escrow (spec 2026-09-03): a hire that pays, no custodian ──────────
 * All persona-signed and root-free, so mcp.ts imports them and agents
 * escrow each other. The chain is the state: an escrow is identified by
 * its three participants, so release/refund re-derive it from
 * the same args — no registry to drift. */
import { escrowAddress, openEscrow, approveRelease, type MultisigApi } from "./chains/escrow.js";

/** Check the checksum and network address format before preparing a transfer. */
export function isTaoAddress(address: string): boolean {
  try { return /^5[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(address) && encodeAddress(decodeAddress(address), 42) === address; }
  catch { return false; }
}

export function requireExpectedPayer(actual: string, expected?: string): void {
  if (expected !== undefined && (!isTaoAddress(expected) || actual !== expected)) {
    throw new Error("payer address changed — review the wallet and approve again");
  }
}

function requireEscrowParties(poster: string, worker: string, arbiter: string): void {
  if (![poster, worker, arbiter].every(isTaoAddress)) throw new Error("escrow participants must be checksummed ss58 addresses");
  if (new Set([poster, worker, arbiter]).size !== 3) throw new Error("escrow requires three distinct participants");
}

export interface EscrowResult {
  escrow: string; txHash: string; executed?: boolean;
  payerAddress: string; network: "test"; poster: string; worker: string; arbiter: string; amount: string;
}

/** Poster funds a 2-of-3 escrow for a hire. worker+arbiter are ss58 addresses. */
export async function escrowOpen(persona: string, worker: string, arbiter: string, amount: string, opts: { expectedPayer?: string } = {}): Promise<EscrowResult> {
  requireWalletMutationAllowed();
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  requireRehearsalNetwork(config.network, config.endpoints.tao);
  requireExpectedPayer(pair.address, opts.expectedPayer);
  requireEscrowParties(pair.address, worker, arbiter);
  const amountRao = parseAmount(amount, TAO_DECIMALS, "TAO").raw;
  if (amountRao <= 0n) throw new Error("amount must be greater than zero");
  const api = (await subtensorFor(config.endpoints.tao)) as unknown as MultisigApi;
  const { escrow, txHash } = await openEscrow(api, pair, { worker, arbiter, amountRao });
  return { escrow, txHash, payerAddress: pair.address, network: "test", poster: pair.address, worker, arbiter, amount: formatRao(amountRao) };
}

/** Approve paying the worker (release) or the poster (refund). The
 * destination decides which: release → worker, refund → poster. Detects
 * first-vs-second approver from chain state. `poster` is the funding
 * account's ss58 (the escrow can't be re-derived without all three). */
export async function escrowApprove(
  persona: string,
  poster: string,
  worker: string,
  arbiter: string,
  amount: string,
  pay: "worker" | "poster",
  opts: { expectedPayer?: string } = {}
): Promise<EscrowResult> {
  requireWalletMutationAllowed();
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  requireRehearsalNetwork(config.network, config.endpoints.tao);
  requireExpectedPayer(pair.address, opts.expectedPayer);
  requireEscrowParties(poster, worker, arbiter);
  if (![poster, worker, arbiter].includes(pair.address)) throw new Error("payer must be an escrow participant");
  if (pay !== "worker" && pay !== "poster") throw new Error("escrow destination must be worker or poster");
  const amountRao = parseAmount(amount, TAO_DECIMALS, "TAO").raw;
  if (amountRao <= 0n) throw new Error("amount must be greater than zero");
  const api = (await subtensorFor(config.endpoints.tao)) as unknown as MultisigApi;
  const destination = pay === "worker" ? worker : poster;
  // The fee burn skims RELEASES only — a refund is not a settlement, the
  // poster gets every rao back. Both approvals run through this same
  // split, so the multisig call hashes agree.
  const split = pay === "worker" ? splitFee(amountRao) : undefined;
  const fee = split && split.feeRao > 0n && split.vault ? { vault: split.vault, feeRao: split.feeRao } : undefined;
  const { executed, txHash } = await approveRelease(api, pair, { poster, worker, arbiter }, destination, amountRao, fee);
  return { escrow: escrowAddress(poster, worker, arbiter), txHash, executed, payerAddress: pair.address, network: "test", poster, worker, arbiter, amount: formatRao(amountRao) };
}

/** Pure read: what the escrow address holds right now. */
export async function escrowStatus(poster: string, worker: string, arbiter: string): Promise<{ escrow: string; heldTao: string }> {
  const config = loadConfig();
  const api = await subtensorFor(config.endpoints.tao);
  const escrow = escrowAddress(poster, worker, arbiter);
  const acct = await api.query.system.account(escrow);
  return { escrow, heldTao: formatRao(acct.data.free.toBigInt()) };
}
