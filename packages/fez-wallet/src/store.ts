import { keychainBackend, keychainFind, keychainStore } from "@fezchat/protocol";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidEntryName, isReservedEntryName, rootEntryName } from "./entry-names.js";

/**
 * Wallet key custody — same pattern as core src/identity/keys.ts, but a
 * SEPARATE keychain service ("fez-wallet"): money and identity never
 * share a compromise domain or a keychain grant.
 *
 * macOS: `security` CLI. Linux: `secret-tool` against the Secret Service.
 * On a platform with neither, or under FEZ_WALLET_STORE=file: 0600 files
 * under ${FEZ_WALLET_HOME ?? ~/.fez}/wallet-store — a worse backend, not a
 * different contract (and what tests use).
 *
 * Every entry name is validated BEFORE either backend is touched (finding
 * #2 — path traversal in the file backend): no "/" and no leading "."
 * rules out both "../x" style climbing and "a/b" nesting. The mnemonic's
 * own entry name is additionally reserved out of the generic readEntry/
 * writeEntry path (finding #1) — it is reachable only through
 * readRootEntry/writeRootEntry below, which cli-commands.ts is the sole
 * importer of.
 */

const SERVICE = "fez-wallet";
const NOSTR_SERVICE = "fez-keys";
const HEX64 = /^[0-9a-f]{64}$/i;

function useKeychain(): boolean {
  return keychainBackend() !== undefined && process.env.FEZ_WALLET_STORE !== "file";
}

function walletHome(): string {
  return process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez");
}

function entryFile(name: string): string {
  return path.join(walletHome(), "wallet-store", name);
}

function assertUsableEntryName(name: string): void {
  if (!isValidEntryName(name)) {
    throw new Error(`invalid entry name "${name}" (letters, digits, "._-" only, no leading dot or slash)`);
  }
  if (isReservedEntryName(name)) {
    throw new Error(`entry name "${name}" is reserved`);
  }
}

function rawRead(name: string): string | undefined {
  if (useKeychain()) {
    return keychainFind(SERVICE, name);
  }
  try {
    return fs.readFileSync(entryFile(name), "utf-8");
  } catch {
    return undefined;
  }
}

function rawWrite(name: string, value: string): void {
  if (useKeychain()) {
    keychainStore(SERVICE, name, value, `fez wallet: ${name}`);
    if (rawRead(name) !== value) throw new Error(`entry "${name}": keychain read-back mismatch`);
    return;
  }
  const file = entryFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

/** The general-purpose entry path — validated and refused for the
 * reserved (mnemonic) name before either backend is dispatched to. This
 * is the only path reachable from mcp.ts/tools.ts/consent.ts/chains/*. */
export function readEntry(name: string): string | undefined {
  assertUsableEntryName(name);
  return rawRead(name);
}

export function writeEntry(name: string, value: string): void {
  assertUsableEntryName(name);
  rawWrite(name, value);
}

/** The mnemonic entry — reachable ONLY here. Only cli-commands.ts may
 * import these two functions (spec invariant 1; enforced by the repo's
 * reserved-literal grep gate plus a manual import-graph check). */
export function readRootEntry(): string | undefined {
  return rawRead(rootEntryName());
}

export function writeRootEntry(value: string): void {
  rawWrite(rootEntryName(), value);
}

/** A standalone remote-signing key's mnemonic — a SEPARATE namespace from
 * both the general per-persona entries (readEntry/writeEntry, which stay
 * "/"-free) and the reserved root entry. `persona` is still run through
 * the same validity check (no "/", no leading ".", not the reserved word)
 * before it's spliced into the compound name below — this name is built
 * from caller input and lands in a file path on the file backend, so the
 * traversal/dotfile guard has to hold here too, not just on the generic
 * path. Sibling to readRootEntry/writeRootEntry, not a replacement for
 * them: the root entry itself is untouched by this pair. */
function remoteHotkeyEntryName(persona: string): string {
  assertUsableEntryName(persona);
  return `remote-hotkey/${persona}`;
}

export function readRemoteHotkeyEntry(persona: string): string | undefined {
  return rawRead(remoteHotkeyEntryName(persona));
}

export function writeRemoteHotkeyEntry(persona: string, value: string): void {
  rawWrite(remoteHotkeyEntryName(persona), value);
}

/** The agent's NOSTR key (service fez-keys, account agent:<persona>) — read-only here; fez core owns that service. Used to sign consent requests. */
export function readAgentNostrKey(persona: string): string | undefined {
  if (useKeychain()) {
    const v = keychainFind(NOSTR_SERVICE, `agent:${persona}`);
    return v && HEX64.test(v) ? v.toLowerCase() : undefined;
  }
  try {
    const v = fs.readFileSync(path.join(walletHome(), "agents", `${persona}.key`), "utf-8").trim();
    return HEX64.test(v) ? v.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
