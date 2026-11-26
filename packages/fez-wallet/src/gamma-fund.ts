/**
 * Funding an agent at one gamma service. Two chain steps, run as one: a
 * payer mints gamma into a deposit at the agent's address, then the
 * agent's own key spends that deposit at the service, which credits it as
 * the agent's balance there. The payer is the owner's treasury (the wallet
 * panel) or the agent itself, topping up from TAO its owner gave it.
 * Gamma is per subnet, so this funds one agent at one service.
 *
 * The whole deposit is spent at once: what the owner funds is the cap,
 * the same rule as the rest of this wallet.
 */
import { signerFromPair, submitAndWait } from "./chains/substrate.js";
import { formatRao, type SubtensorApi } from "./chains/subtensor.js";
import type { WalletPair } from "./derive.js";
import type { GammaServiceReport } from "./gamma-services.js";

/** A mint that would fill more than this far below its quote fails instead. */
const SLIPPAGE_PERCENT = 3n;

export type GammaFunding = {
  service: { netuid: number; name: string; hotkey: string };
  /** What the TAO would mint right now, in 10^-9 gamma. 0 when no TAO was named. */
  quotedGamma: bigint;
} & ({ sent: false } | { sent: true; mintTx?: string; spendTx: string; spentGamma: bigint });

/** What `taoRao` would mint on a subnet right now, in 10^-9 gamma. Sends nothing. */
export async function quoteGammaMint(api: SubtensorApi, netuid: number, taoRao: bigint): Promise<bigint> {
  const answer = (await api.call.gammaRuntimeApi.simMintGamma(netuid, taoRao)).toJSON() as { ok?: unknown[]; err?: { module?: { index: number; error: string } } };
  if (Array.isArray(answer.ok)) return BigInt(answer.ok[2] as number | string);
  let why = JSON.stringify(answer.err);
  try {
    const m = answer.err!.module!;
    const decoded = api.registry.findMetaError(new Uint8Array([m.index, parseInt(m.error.slice(2, 4), 16)]));
    why = `${decoded.name}: ${decoded.docs.join(" ")}`;
  } catch { /* keep the raw error */ }
  throw new Error(`the chain will not mint gamma on subnet ${netuid} (${why})`);
}

async function spendable(api: SubtensorApi, netuid: number, hotkey: string): Promise<bigint> {
  const info = (await api.call.gammaRuntimeApi.getGammaDeposit(netuid, hotkey)).toJSON() as { spendable?: number | string } | null;
  return BigInt(info?.spendable ?? 0);
}

const ambiguous = (what: string) => () =>
  new Error(`${what} was submitted but not confirmed — it MAY OR MAY NOT have landed on chain. Do not retry blindly: check the deposit first.`);

export async function fundGamma(
  deps: {
    api: SubtensorApi;
    /** Whose TAO pays for the mint: the treasury, or the agent itself. */
    payer: WalletPair;
    agent: WalletPair;
    /** A discovery run; only services that passed its checks can be funded. */
    services: GammaServiceReport[];
    signer?: (pair: WalletPair) => Promise<unknown>; // test seam
  },
  args: { netuid: number; /** 0 = mint nothing, spend the deposit already there */ taoRao: bigint; confirm: boolean; service?: string },
): Promise<GammaFunding> {
  const { api, payer, agent } = deps;
  const signer = deps.signer ?? signerFromPair;
  const ready = deps.services.filter((s) => s.ready && s.netuid === args.netuid && (!args.service || s.hotkey === args.service));
  if (!ready.length) throw new Error(`no ready gamma service on subnet ${args.netuid}${args.service ? ` at ${args.service}` : ""} — see: fez-wallet gamma services`);
  if (ready.length > 1) throw new Error(`subnet ${args.netuid} has ${ready.length} ready services; name one with --service <hotkey>: ${ready.map((s) => `${s.hotkey} (${s.name ?? "unnamed"})`).join(", ")}`);
  const service = { netuid: ready[0].netuid, name: ready[0].name ?? "unnamed", hotkey: ready[0].hotkey };

  let quotedGamma = 0n;
  if (args.taoRao > 0n) {
    const free = (await api.query.system.account(payer.address)).data.free.toBigInt();
    if (free < args.taoRao) throw new Error(`${payer.address} has ${formatRao(free)} TAO free; minting with ${formatRao(args.taoRao)} needs more`);
    quotedGamma = await quoteGammaMint(api, args.netuid, args.taoRao);
  }
  if (!args.confirm) return { service, quotedGamma, sent: false };

  let mintTx: string | undefined;
  if (args.taoRao > 0n) {
    const minOut = quotedGamma - (quotedGamma * SLIPPAGE_PERCENT) / 100n;
    ({ txHash: mintTx } = await submitAndWait(api, api.tx.subtensorModule.mintGamma(agent.address, args.netuid, args.taoRao, minOut, null), await signer(payer), {
      onTimeout: ambiguous(`the gamma mint for ${agent.address}`),
    }));
  }
  const amount = await spendable(api, args.netuid, agent.address);
  if (amount === 0n) throw new Error(`no gamma deposit to spend at ${agent.address} on subnet ${args.netuid}${mintTx ? ` (the mint landed: tx ${mintTx})` : ""}`);
  try {
    const { txHash: spendTx } = await submitAndWait(api, api.tx.subtensorModule.spendGamma(service.hotkey, args.netuid, amount), await signer(agent), {
      onTimeout: ambiguous(`the gamma spend at ${service.name}`),
    });
    return { service, quotedGamma, sent: true, mintTx, spendTx, spentGamma: amount };
  } catch (e) {
    // The money is not lost here: it is the owner's deposit until spent.
    throw new Error(
      `${mintTx ? "minted, but " : ""}the spend at ${service.name} failed: ${(e as Error).message}. ${formatRao(amount)} gamma sits in a deposit at ${agent.address} on subnet ${args.netuid}; ` +
        `finish with: fez-wallet gamma fund <persona> ${args.netuid} 0 --confirm`,
    );
  }
}

/** A funding or a quote as the wallet panel receives it: the panel holds no keys, so it runs the command and reads this. */
export interface GammaFundingJson { sent: boolean; netuid: number; service: string; hotkey: string; quotedUsd: string; spentUsd?: string; mintTx?: string; spendTx?: string }

export function fundingJson(done: GammaFunding): GammaFundingJson {
  return {
    sent: done.sent, netuid: done.service.netuid, service: done.service.name, hotkey: done.service.hotkey, quotedUsd: formatRao(done.quotedGamma),
    ...(done.sent ? { spentUsd: formatRao(done.spentGamma), ...(done.mintTx ? { mintTx: done.mintTx } : {}), spendTx: done.spendTx } : {}),
  };
}
