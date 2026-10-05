import { fezHome } from "../shared/fez-home.js";
import { keychainBackend, keychainFind, keychainStore } from "../keychain.js";
import fs from "node:fs";
import path from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import * as nip49 from "nostr-tools/nip49";

/**
 * Key custody — Buzz's model, fez-shaped. Identity keys are the actual
 * root of trust here (community creator rights, membership, attestation
 * authority are all bound to pubkeys), so they belong in the OS keychain,
 * not plaintext dotfiles.
 *
 * - macOS and Linux: the platform keychain (service "fez-keys", one item
 *   per key name) through the shared helper, which is the same store the
 *   desktop app writes — the two MUST agree, or the app mints an identity
 *   the CLI and the background worker cannot find.
 * - elsewhere (or FEZ_KEYSTORE=file): 0600 files under ~/.fez, exactly
 *   the pre-custody layout — a worse backend, not a different contract.
 *
 * Key names: "default" is the user; "agent:<name>" are service
 * identities. Legacy plaintext files (~/.fez/default.key,
 * ~/.fez/agents/<name>.key) migrate on first read: keychain write, read
 * BACK and compare, only then delete the file — a half-migrated key
 * would orphan everything its pubkey owns.
 *
 * Portability is NIP-49: export/import as passphrase-encrypted
 * ncryptsec strings (`fez keys export|import`).
 */

const SERVICE = "fez-keys";
const HEX64 = /^[0-9a-f]{64}$/i;

/** What this platform calls the store, for anything the user reads. */
function keystoreLabel(): string {
  return keychainBackend() === "security" ? "macOS keychain" : "system keyring";
}

function useKeychain(): boolean {
  return keychainBackend() !== undefined && process.env.FEZ_KEYSTORE !== "file";
}

/** Legacy/fallback file path for a key name. */
function keyFile(name: string): string {
  return name === "default"
    ? fezHome("default.key")
    : fezHome("agents", `${name.replace(/^agent:/, "")}.key`);
}

/** Names index — key NAMES only (never material); lets `fez keys list` enumerate without dumping the keychain. */
const INDEX_FILE = fezHome("keys.json");
function readIndex(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
    return Array.isArray(parsed.names) ? parsed.names.filter((n: unknown) => typeof n === "string") : [];
  } catch {
    return [];
  }
}
function indexAdd(name: string): void {
  const names = new Set(readIndex());
  if (names.has(name)) return;
  names.add(name);
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify({ names: [...names].sort() }, null, 1), { mode: 0o600 });
}

/**
 * Read one key from the keychain. Absent returns undefined; any OTHER
 * failure — a denied prompt, a locked keyring — throws. The two used to collapse into
 * undefined, and loadOrCreateKey's read-or-generate then MINTED A
 * REPLACEMENT for an agent whose key still existed, silently orphaning
 * its roster membership and attestations. Same distinction the Rust
 * side's get_identity has always drawn.
 */
function keychainRead(name: string): string | undefined {
  // keychainFind keeps absence and access failure apart, which is the
  // distinction this function exists for: a denied or locked store must
  // throw rather than read as "no key" and mint a replacement.
  const value = keychainFind(SERVICE, name);
  if (value === undefined) return undefined;
  return HEX64.test(value) ? value.toLowerCase() : undefined;
}

function keychainWrite(name: string, hex: string): void {
  keychainStore(SERVICE, name, hex, `fez key: ${name}`);
}

function fileRead(name: string): string | undefined {
  try {
    const value = fs.readFileSync(keyFile(name), "utf-8").trim();
    return HEX64.test(value) ? value.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function fileWrite(name: string, hex: string): void {
  const file = keyFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, hex, { mode: 0o600 });
}

/**
 * Read a key. On keychain platforms a legacy plaintext file migrates
 * here: written to the keychain, read back and compared, and only then
 * deleted (with a loud note — this is the user's root identity moving).
 */
export function getKey(name: string): string | undefined {
  if (!useKeychain()) {
    const value = fileRead(name);
    if (value) indexAdd(name);
    return value;
  }
  const existing = keychainRead(name);
  if (existing) {
    indexAdd(name);
    return existing;
  }
  const legacy = fileRead(name);
  if (!legacy) return undefined;
  keychainWrite(name, legacy);
  if (keychainRead(name) !== legacy) {
    throw new Error(`key "${name}": keychain read-back mismatch after migration — plaintext file left untouched`);
  }
  fs.rmSync(keyFile(name), { force: true });
  indexAdd(name);
  console.log(`🔐 Key "${name}" migrated: ${keyFile(name)} → ${keystoreLabel()} (service "${SERVICE}"). Export anytime: fez keys export ${name}`);
  return legacy;
}

export function setKey(name: string, hex: string): void {
  if (!HEX64.test(hex)) throw new Error(`key "${name}": expected 64 hex chars`);
  const value = hex.toLowerCase();
  if (useKeychain()) {
    keychainWrite(name, value);
    if (keychainRead(name) !== value) throw new Error(`key "${name}": keychain read-back mismatch`);
  } else {
    fileWrite(name, value);
  }
  indexAdd(name);
}

/** Read-or-generate — the stable-identity path every service uses. */
export function loadOrCreateKey(name: string): string {
  const existing = getKey(name);
  if (existing) return existing;
  const hex = bytesToHex(generateSecretKey());
  setKey(name, hex);
  console.log(`🔑 Generated identity "${name}" → ${useKeychain() ? `${keystoreLabel()} (service "${SERVICE}")` : keyFile(name)}`);
  return hex;
}

/** Known key names with pubkeys — index plus any legacy files still on disk. */
export function listKeys(): { name: string; pubkey: string; backend: "keychain" | "file" }[] {
  const names = new Set(readIndex());
  try {
    if (fs.existsSync(keyFile("default"))) names.add("default");
    for (const f of fs.readdirSync(fezHome("agents"))) {
      if (f.endsWith(".key")) names.add(`agent:${f.slice(0, -4)}`);
    }
  } catch { /* no agents dir yet */ }
  const out: { name: string; pubkey: string; backend: "keychain" | "file" }[] = [];
  for (const name of [...names].sort()) {
    try {
      const backend = useKeychain() && keychainRead(name) ? "keychain" : "file";
      const hex = backend === "keychain" ? keychainRead(name) : fileRead(name);
      if (hex) out.push({ name, pubkey: getPublicKey(hexToBytes(hex)), backend });
    } catch {
      // access denied for this one item — listing the others still helps
    }
  }
  return out;
}

/** NIP-49 export: the key as a passphrase-encrypted ncryptsec string. */
export function exportKey(name: string, passphrase: string): string {
  const hex = getKey(name);
  if (!hex) throw new Error(`no key named "${name}"`);
  return nip49.encrypt(hexToBytes(hex), passphrase);
}

/** NIP-49 import: decrypt an ncryptsec and store it under `name`. Returns the pubkey. */
export function importKey(name: string, ncryptsec: string, passphrase: string): string {
  const secret = nip49.decrypt(ncryptsec, passphrase);
  const hex = bytesToHex(secret);
  setKey(name, hex);
  return getPublicKey(secret);
}
