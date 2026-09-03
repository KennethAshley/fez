import { readEntry } from "./store.js";
import { pairFromStored } from "./derive.js";
import { isValidEntryName, isReservedEntryName } from "./entry-names.js";
import { loadConfig, type Network } from "./config.js";
import { parseAmount } from "./chains/adapter.js";
import { TAO_DECIMALS } from "./chains/substrate.js";
import {
  addStake, connectSubtensor, formatRao, removeStake, stakedAlpha, uidFor,
  type SubtensorApi,
} from "./chains/subtensor.js";
import { mirrorSubnet } from "./storage-mirror.js";

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
export function requireRehearsalNetwork(network: Network): void {
  if (network === "finney") {
    throw new Error("register/stake/unstake are testnet-only for now — switch with: fez-wallet network test");
  }
}

export interface StakeResult {
  persona: string;
  netuid: number;
  txHash: string;
  amount: string;
}

export async function stakePersona(persona: string, amount: string, netuid = DEFAULT_NETUID): Promise<StakeResult> {
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  requireRehearsalNetwork(config.network);
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
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  requireRehearsalNetwork(config.network);
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
}

export async function personaStatus(persona: string, netuid = DEFAULT_NETUID): Promise<PersonaChainStatus> {
  const pair = requirePersonaPair(persona);
  const config = loadConfig();
  const api = await subtensorFor(config.endpoints.tao);
  const [uid, acct, staked] = await Promise.all([
    uidFor(api, netuid, pair.address),
    api.query.system.account(pair.address),
    stakedAlpha(api, netuid, pair.address, pair.address),
  ]);
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
  };
}
