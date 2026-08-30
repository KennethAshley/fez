import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import type { SignedNostrEvent } from "./consent.js";
import type { Network as ChainNetwork } from "./storage-mirror.js";
import type { Amount } from "./chains/adapter.js";

/** Widened locally, not in networks.ts: the TAO network selector
 * (test/finney) that file gates stays exhaustive, but a receipt can also
 * record an x402 payment on a chain that selector never named (base,
 * base-sepolia). `(string & {})` keeps the two known literals as
 * autocomplete hints without narrowing what's actually accepted. */
export type Network = ChainNetwork | (string & {});

/**
 * A payment, bound to the message that earned it. Substrate transfers
 * carry no memo, so this link cannot live on-chain — it has to be an
 * off-chain event. Unlike a NIP-57 zap receipt it needs no trusted
 * signer: the transfer is public, so anyone can check this against the
 * block and a forgery fails.
 */
export const KIND_PAYMENT_RECEIPT = 47040;

export interface ParsedReceipt {
  payer: string;
  forEvent?: string;
  payee?: string;
  channelId?: string;
  raw: bigint;
  symbol: string;
  chain: string;
  network: Network;
  txHash: string;
  blockRef?: string;
  memo: string;
}

export function buildReceipt(opts: {
  agentSecretHex: string;
  forEvent?: string;
  payeePubkey?: string;
  channelId?: string;
  amount: Amount;
  chain: string;
  network: Network;
  txHash: string;
  blockRef?: string;
  memo?: string;
}): SignedNostrEvent {
  const tags: string[][] = [
    ["amount", opts.amount.raw.toString()],
    ["asset", opts.amount.symbol],
    ["chain", opts.chain],
    ["network", opts.network],
    ["tx", opts.txHash],
  ];
  if (opts.forEvent) tags.unshift(["e", opts.forEvent]);
  if (opts.payeePubkey) tags.push(["p", opts.payeePubkey]);
  if (opts.channelId) tags.push(["h", opts.channelId]);
  if (opts.blockRef) tags.push(["block", opts.blockRef]);
  return finalizeEvent(
    { kind: KIND_PAYMENT_RECEIPT, created_at: Math.floor(Date.now() / 1000), tags, content: opts.memo ?? "" },
    hexToBytes(opts.agentSecretHex)
  );
}

export function parseReceipt(ev: SignedNostrEvent): ParsedReceipt | undefined {
  if (ev.kind !== KIND_PAYMENT_RECEIPT) return undefined;
  const tag = (k: string) => ev.tags.find((t) => t[0] === k)?.[1];
  const amount = tag("amount");
  const txHash = tag("tx");
  const chain = tag("chain");
  const network = tag("network") as Network | undefined;
  if (!amount || !/^\d+$/.test(amount) || !txHash || !chain || !network) return undefined;
  return {
    payer: ev.pubkey,
    forEvent: tag("e"),
    payee: tag("p"),
    channelId: tag("h"),
    raw: BigInt(amount),
    symbol: tag("asset") ?? "TAO",
    chain,
    network,
    txHash,
    blockRef: tag("block"),
    memo: ev.content,
  };
}

/**
 * "unverifiable" is NOT "false". A pruned block, an unreachable node or a
 * receipt with no block reference all mean we could not look, and a UI
 * that renders those the same as a failed check is lying about which one
 * happened (spec §4).
 */
export async function verifyReceipt(
  r: ParsedReceipt,
  lookup: (blockRef: string, txHash: string) => Promise<{ from: string; to: string; raw: bigint } | undefined>,
  expected: { from: string; to: string }
): Promise<"verified" | "unverifiable" | "false"> {
  if (!r.blockRef) return "unverifiable";
  const onChain = await lookup(r.blockRef, r.txHash);
  if (!onChain) return "unverifiable";
  const matches =
    onChain.raw === r.raw && onChain.to === expected.to && onChain.from === expected.from;
  return matches ? "verified" : "false";
}
