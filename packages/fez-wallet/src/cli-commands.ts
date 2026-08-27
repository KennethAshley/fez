import { generateWalletMnemonic, deriveAgentPair, treasuryPair, pairFromStored } from "./derive.js";
import { readEntry, writeEntry, readRootEntry, writeRootEntry } from "./store.js";
import { isValidEntryName, isReservedEntryName } from "./entry-names.js";
import { loadConfig, saveConfig, assignEvmIndex } from "./config.js";
import { type ChainAdapter, parseAmount, formatAmount } from "./chains/adapter.js";
import { mirrorAddresses, mirrorEndpoint, mirrorSpend } from "./storage-mirror.js";

/**
 * The ceremony. This module is the ONLY place the "root" entry (the
 * mnemonic) is ever read or written — mcp.ts and tools.ts see derived
 * pairs and nothing else (spec invariant 1). It reaches the mnemonic
 * through store.ts's readRootEntry/writeRootEntry, which no other
 * module imports.
 */

export interface CliIo {
  print(line: string): void;
}

function requireRoot(): string {
  const mnemonic = readRootEntry();
  if (!mnemonic) throw new Error("no wallet yet — run: fez-wallet init");
  return mnemonic;
}

/** A persona name doubles as a store entry name — same rules apply, plus
 * it can never collide with the reserved mnemonic entry (finding #1d). */
function requireUsablePersonaName(persona: string): void {
  if (!isValidEntryName(persona)) {
    throw new Error(`invalid persona name "${persona}" (letters, digits, "._-" only, no leading dot or slash)`);
  }
  if (isReservedEntryName(persona)) {
    throw new Error(`"${persona}" is a reserved name and cannot be used as a persona`);
  }
}

export async function cmdInit(io: CliIo): Promise<void> {
  if (readRootEntry()) throw new Error("a wallet root already exists — refusing to overwrite it");
  const mnemonic = generateWalletMnemonic();
  writeRootEntry(mnemonic);
  io.print("wallet created. WRITE THESE 24 WORDS DOWN — they are shown exactly once:");
  io.print("");
  io.print(`  ${mnemonic}`);
  io.print("");
  const treasuryAddress = treasuryPair(mnemonic).address;
  io.print(`treasury address: ${treasuryAddress}`);
  io.print("fund the treasury, then: fez-wallet derive <persona> && fez-wallet fund <persona> <amount>");
  await mirrorAddresses({ treasury: treasuryAddress });
  const config = loadConfig();
  await mirrorEndpoint(config.endpoints.tao);
}

export async function cmdDerive(io: CliIo, persona: string): Promise<void> {
  requireUsablePersonaName(persona);
  const mnemonic = requireRoot();
  const existing = readEntry(persona);
  const pair = existing ? pairFromStored(existing) : deriveAgentPair(mnemonic, persona);
  if (!existing) writeEntry(persona, JSON.stringify(pair));
  const config = loadConfig();
  assignEvmIndex(config, persona);
  saveConfig(config);
  io.print(`${persona}: ${pair.address}`);
  await mirrorAddresses({ persona: { name: persona, address: pair.address } });
}

export async function cmdFund(io: CliIo, adapter: ChainAdapter, persona: string, amount: string): Promise<void> {
  requireUsablePersonaName(persona);
  const mnemonic = requireRoot();
  const stored = readEntry(persona);
  if (!stored) throw new Error(`no wallet for "${persona}" — run: fez-wallet derive ${persona}`);
  const to = pairFromStored(stored).address;
  const decimals = adapter.assets[0].decimals;
  const parsed = parseAmount(amount, decimals, adapter.assets[0].symbol);
  const { txHash } = await adapter.transfer(treasuryPair(mnemonic), to, parsed);
  io.print(`funded ${persona} with ${formatAmount(parsed)} (tx ${txHash})`);
  const config = loadConfig();
  await mirrorSpend({
    ts: new Date().toISOString(),
    persona: "treasury",
    to,
    amount,
    asset: adapter.assets[0].symbol,
    txHash,
    consent: "auto",
    network: config.network,
  });
}

export async function cmdStatus(io: CliIo, adapter: ChainAdapter): Promise<void> {
  const mnemonic = requireRoot();
  const config = loadConfig();
  const asset = adapter.assets[0].symbol;
  const treasury = treasuryPair(mnemonic);
  await mirrorAddresses({ treasury: treasury.address });
  await mirrorEndpoint(config.endpoints.tao);
  const tb = await adapter.balance(treasury.address, asset);
  io.print(`treasury  ${treasury.address}  ${formatAmount(tb)}`);
  for (const persona of Object.keys(config.personas).sort()) {
    const stored = readEntry(persona);
    if (!stored) continue;
    const addr = pairFromStored(stored).address;
    const b = await adapter.balance(addr, asset);
    io.print(`${persona}  ${addr}  ${formatAmount(b)}`);
  }
}
