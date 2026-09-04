import { createKeyMulti, encodeAddress, sortAddresses } from "@polkadot/util-crypto";
import type { WalletPair } from "../derive.js";
import { signerFromPair, submitAndWait, ambiguousTransferError, type SubstrateApi, type Submittable } from "./substrate.js";

/**
 * Escrow as a native 2-of-3 multisig — proven live on testnet
 * 2026-09-03 (fund → poster+worker release, arbiter never signs). No
 * custodian, no contract: the funds sit at an address only two of
 * {poster, worker, arbiter} can move, and the address is deterministic
 * from the signatory set, so opening one is just a transfer to it.
 *
 * The release is a two-step multisig approval keyed on the EXACT call
 * both parties sign (pay the worker, or refund the poster). The pallet
 * combines approvals only when the call hash matches byte-for-byte, so
 * the release amount and destination must be reproduced identically by
 * the second signer — the verb rebuilds the same call, never a "close
 * enough" one.
 */

const SS58 = 42;
const THRESHOLD = 2;

export interface MultisigApi extends SubstrateApi {
  query: SubstrateApi["query"] & {
    multisig: {
      multisigs(addr: string, callHash: string): Promise<{
        isSome: boolean;
        unwrap(): { when: { height: { toNumber(): number }; index: { toNumber(): number } }; approvals: { length: number } };
      }>;
    };
  };
  tx: SubstrateApi["tx"] & {
    balances: SubstrateApi["tx"]["balances"];
    multisig: {
      approveAsMulti(threshold: number, others: string[], maybeTimepoint: unknown, callHash: string, maxWeight: unknown): Submittable;
      asMulti(threshold: number, others: string[], maybeTimepoint: unknown, call: string, maxWeight: unknown): Submittable;
    };
  };
}

/** The escrow's on-chain address, from its three participants. Pure —
 * the same three keys always derive the same account, which is how
 * `release` finds the escrow again with no registry. */
export function escrowAddress(poster: string, worker: string, arbiter: string): string {
  return encodeAddress(createKeyMulti([poster, worker, arbiter], THRESHOLD), SS58);
}

/** The co-signers a given signer must name (everyone but themselves,
 * sorted — the pallet demands sorted `other_signatories`). */
function others(self: string, poster: string, worker: string, arbiter: string): string[] {
  return sortAddresses([poster, worker, arbiter].filter((a) => a !== self), SS58);
}

/** Open: the poster funds the derived address. A plain transfer — the
 * multisig account needs no setup. Returns the address so the worker can
 * verify the money is real before working. */
export async function openEscrow(
  api: MultisigApi,
  poster: WalletPair,
  parties: { worker: string; arbiter: string; amountRao: bigint }
): Promise<{ escrow: string; txHash: string }> {
  const escrow = escrowAddress(poster.address, parties.worker, parties.arbiter);
  const signer = await signerFromPair(poster);
  const { txHash } = await submitAndWait(
    api,
    api.tx.balances.transferKeepAlive(escrow, parties.amountRao),
    signer,
    { onTimeout: () => ambiguousTransferError(escrow, 120_000) }
  );
  return { escrow, txHash };
}

/**
 * Approve a release (pay the worker) or refund (pay the poster). Detects
 * whether the caller is the FIRST approver (registers the approval, funds
 * stay put) or the SECOND (executes, funds move) from the multisig's own
 * chain state — so one verb serves both signers.
 */
export async function approveRelease(
  api: MultisigApi,
  signer: WalletPair,
  parties: { poster: string; worker: string; arbiter: string },
  destination: string,
  amountRao: bigint
): Promise<{ executed: boolean; txHash: string }> {
  const escrow = escrowAddress(parties.poster, parties.worker, parties.arbiter);
  // allow-death, not keep-alive: the release empties the escrow, and a
  // keep-alive transfer refuses the last drop (would leave the escrow
  // below the existential deposit). BOTH signers must build this same
  // call — the pallet combines approvals only on identical call hashes.
  const payCall = api.tx.balances.transferAllowDeath(destination, amountRao);
  const callHash = payCall.method.hash.toHex();
  const maxWeight = (await payCall.paymentInfo(escrow)).weight;
  const co = others(signer.address, parties.poster, parties.worker, parties.arbiter);
  const kp = await signerFromPair(signer);

  const pending = await api.query.multisig.multisigs(escrow, callHash);
  if (!pending.isSome) {
    // First approval: register it. The funds do not move yet.
    const { txHash } = await submitAndWait(
      api,
      api.tx.multisig.approveAsMulti(THRESHOLD, co, null, callHash, maxWeight),
      kp,
      { onTimeout: () => new Error("approval submitted but not confirmed — check escrow status before retrying") }
    );
    return { executed: false, txHash };
  }
  // Second approval: execute with the full call. Two of three → funds move.
  const info = pending.unwrap();
  const timepoint = { height: info.when.height.toNumber(), index: info.when.index.toNumber() };
  const fullCall = payCall.method.toHex();
  const before = (await api.query.system.account(escrow)).data.free.toBigInt();
  const { txHash } = await submitAndWait(
    api,
    api.tx.multisig.asMulti(THRESHOLD, co, timepoint, fullCall, maxWeight),
    kp,
    { onTimeout: () => ambiguousTransferError(destination, 120_000) }
  );
  // asMulti's OUTER extrinsic succeeds even when the inner transfer fails
  // (it surfaces as a MultisigExecuted{result:Err} event, not a dispatch
  // error) — so "executed" is confirmed by the escrow actually draining,
  // not by the extrinsic landing. Read the truth rather than trust the tx.
  const after = (await api.query.system.account(escrow)).data.free.toBigInt();
  if (after >= before) {
    throw new Error("the release approval landed but the escrow did not pay out — the inner transfer was rejected (check the amount matches what was opened, byte for byte)");
  }
  return { executed: true, txHash };
}
