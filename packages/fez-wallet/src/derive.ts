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

export function pairFromStored(json: string): WalletPair {
  const p = JSON.parse(json) as WalletPair;
  if (!p.publicKeyHex || !p.secretKeyHex) throw new Error("malformed stored pair");
  // Recompute the address from the public key — storage carries no authority.
  return toPair(hexToU8a(`0x${p.publicKeyHex}`), hexToU8a(`0x${p.secretKeyHex}`));
}
