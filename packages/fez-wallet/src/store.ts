import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Wallet key custody — same pattern as core src/identity/keys.ts, but a
 * SEPARATE keychain service ("fez-wallet"): money and identity never
 * share a compromise domain or a keychain grant.
 *
 * macOS: `security` CLI. Elsewhere, or under FEZ_WALLET_STORE=file:
 * 0600 files under ${FEZ_WALLET_HOME ?? ~/.fez}/wallet-store — a worse
 * backend, not a different contract (and what tests use).
 */

const SERVICE = "fez-wallet";
const NOSTR_SERVICE = "fez-keys";
const HEX64 = /^[0-9a-f]{64}$/i;

function useKeychain(): boolean {
  return process.platform === "darwin" && process.env.FEZ_WALLET_STORE !== "file";
}

function walletHome(): string {
  return process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez");
}

function entryFile(name: string): string {
  return path.join(walletHome(), "wallet-store", name);
}

export function readEntry(name: string): string | undefined {
  if (useKeychain()) {
    const out = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"], {
      encoding: "utf-8",
    });
    return out.status === 0 ? out.stdout.trim() : undefined;
  }
  try {
    return fs.readFileSync(entryFile(name), "utf-8");
  } catch {
    return undefined;
  }
}

export function writeEntry(name: string, value: string): void {
  if (useKeychain()) {
    const out = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-l", `fez wallet: ${name}`, "-w", value],
      { stdio: "ignore" }
    );
    if (out.status !== 0) throw new Error(`keychain write failed for "${name}" (security exited ${out.status})`);
    if (readEntry(name) !== value) throw new Error(`entry "${name}": keychain read-back mismatch`);
    return;
  }
  const file = entryFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

/** The agent's NOSTR key (service fez-keys, account agent:<persona>) — read-only here; fez core owns that service. Used to sign consent requests. */
export function readAgentNostrKey(persona: string): string | undefined {
  if (useKeychain()) {
    const out = spawnSync(
      "security",
      ["find-generic-password", "-s", NOSTR_SERVICE, "-a", `agent:${persona}`, "-w"],
      { encoding: "utf-8" }
    );
    const v = out.status === 0 ? out.stdout.trim() : undefined;
    return v && HEX64.test(v) ? v.toLowerCase() : undefined;
  }
  try {
    const v = fs.readFileSync(path.join(walletHome(), "agents", `${persona}.key`), "utf-8").trim();
    return HEX64.test(v) ? v.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
