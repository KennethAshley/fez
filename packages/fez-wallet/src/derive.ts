import {
  mnemonicGenerate,
  mnemonicValidate,
  mnemonicToMiniSecret,
  sr25519PairFromSeed,
  keyExtractPath,
  keyFromPath,
  encodeAddress,
} from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { privateKeyToAccount } from "viem/accounts";

/**
 * The money tree. One mnemonic (stored as the root keychain entry, CLI-only) hard-
 * derives per-agent sr25519 accounts at //<persona>. Only the derived
 * pair is ever stored for an agent — a hard path cannot be climbed back
 * to the parent, so an agent's entry never leaks the treasury.
 */

export interface WalletPair {
  publicKeyHex: string; // no 0x prefix
  secretKeyHex: string; // no 0x prefix (sr25519 64-byte secret)
  address: string;      // SS58 prefix 42 (substrate generic — what bittensor uses)
}

const SS58_PREFIX = 42;

export function generateWalletMnemonic(): string {
  return mnemonicGenerate(24);
}

function toPair(pk: Uint8Array, sk: Uint8Array): WalletPair {
  return {
    publicKeyHex: u8aToHex(pk, undefined, false),
    secretKeyHex: u8aToHex(sk, undefined, false),
    address: encodeAddress(pk, SS58_PREFIX),
  };
}

function basePair(mnemonic: string) {
  if (!mnemonicValidate(mnemonic)) throw new Error("invalid mnemonic");
  return sr25519PairFromSeed(mnemonicToMiniSecret(mnemonic));
}

export function treasuryPair(mnemonic: string): WalletPair {
  const p = basePair(mnemonic);
  return toPair(p.publicKey, p.secretKey);
}

export function deriveAgentPair(mnemonic: string, persona: string): WalletPair {
  const { path } = keyExtractPath(`//${persona}`);
  const d = keyFromPath(basePair(mnemonic), path, "sr25519");
  return toPair(d.publicKey, d.secretKey);
}

export interface EvmPair { addressHex: `0x${string}`; privateKeyHex: `0x${string}` }

/** The money tree's EVM branch: standard BIP44 so mnemonic+index recovers
 *  in any stock wallet. Index is per-persona, persisted in wallet config
 *  (see config.ts's assignEvmIndex). */
export function deriveAgentEvm(mnemonic: string, index: number): EvmPair {
  if (!mnemonicValidate(mnemonic)) throw new Error("invalid mnemonic");
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(`m/44'/60'/0'/0/${index}`);
  if (!key.privateKey) throw new Error("evm derivation failed");
  const privateKeyHex = (`0x` + Buffer.from(key.privateKey).toString("hex")) as `0x${string}`;
  return { addressHex: privateKeyToAccount(privateKeyHex).address, privateKeyHex };
}

/** Reads the EVM pair stored alongside the sr25519 pair (see cmdDerive) —
 * same generic-error contract as pairFromStored: never echoes the input. */
export function evmPairFromStored(json: string): EvmPair {
  try {
    const p = JSON.parse(json) as { evm?: Partial<EvmPair> };
    if (!p.evm?.addressHex || !p.evm?.privateKeyHex) throw new Error("malformed stored pair");
    return { addressHex: p.evm.addressHex, privateKeyHex: p.evm.privateKeyHex };
  } catch {
    throw new Error("malformed stored pair");
  }
}

export function pairFromStored(json: string): WalletPair {
  // Wrapped whole: a SyntaxError from JSON.parse (or a hex decode error
  // below) can otherwise quote the offending input back — and when the
  // input is a mnemonic read off the reserved entry by mistake, that
  // input IS the secret. Every failure path here collapses to one
  // generic message that never echoes what it was given (finding #1b).
  try {
    const p = JSON.parse(json) as WalletPair;
    if (!p.publicKeyHex || !p.secretKeyHex) throw new Error("malformed stored pair");
    // Recompute the address from the public key — storage carries no authority.
    return toPair(hexToU8a(`0x${p.publicKeyHex}`), hexToU8a(`0x${p.secretKeyHex}`));
  } catch {
    throw new Error("malformed stored pair");
  }
}
