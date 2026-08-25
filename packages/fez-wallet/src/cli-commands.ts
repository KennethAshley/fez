import { generateWalletMnemonic, deriveAgentPair, treasuryPair, pairFromStored } from "./derive.js";
import { readEntry, writeEntry } from "./store.js";
import { loadConfig, saveConfig, assignEvmIndex } from "./config.js";
import { type ChainAdapter, parseAmount, formatAmount } from "./chains/adapter.js";

/**
 * The ceremony. This module is the ONLY place the "root" entry (the
 * mnemonic) is ever read or written — mcp.ts and tools.ts see derived
 * pairs and nothing else (spec invariant 1).
 */

const ROOT = "root";

export interface CliIo {
  print(line: string): void;
}

function requireRoot(): string {
  const mnemonic = readEntry(ROOT);
  if (!mnemonic) throw new Error("no wallet yet — run: fez-wallet init");
  return mnemonic;
}

export function cmdInit(io: CliIo): void {
  if (readEntry(ROOT)) throw new Error("a wallet root already exists — refusing to overwrite it");
  const mnemonic = generateWalletMnemonic();
  writeEntry(ROOT, mnemonic);
  io.print("wallet created. WRITE THESE 24 WORDS DOWN — they are shown exactly once:");
  io.print("");
  io.print(`  ${mnemonic}`);
  io.print("");
  io.print(`treasury address: ${treasuryPair(mnemonic).address}`);
  io.print("fund the treasury, then: fez-wallet derive <persona> && fez-wallet fund <persona> <amount>");
}

export function cmdDerive(io: CliIo, persona: string): void {
  const mnemonic = requireRoot();
  const existing = readEntry(persona);
  const pair = existing ? pairFromStored(existing) : deriveAgentPair(mnemonic, persona);
  if (!existing) writeEntry(persona, JSON.stringify(pair));
  const config = loadConfig();
  assignEvmIndex(config, persona);
  saveConfig(config);
  io.print(`${persona}: ${pair.address}`);
}

export async function cmdFund(io: CliIo, adapter: ChainAdapter, persona: string, amount: string): Promise<void> {
  const mnemonic = requireRoot();
  const stored = readEntry(persona);
  if (!stored) throw new Error(`no wallet for "${persona}" — run: fez-wallet derive ${persona}`);
  const to = pairFromStored(stored).address;
  const decimals = adapter.assets[0].decimals;
  const parsed = parseAmount(amount, decimals, adapter.assets[0].symbol);
  const { txHash } = await adapter.transfer(treasuryPair(mnemonic), to, parsed);
  io.print(`funded ${persona} with ${formatAmount(parsed)} (tx ${txHash})`);
}

export async function cmdStatus(io: CliIo, adapter: ChainAdapter): Promise<void> {
  const mnemonic = requireRoot();
  const config = loadConfig();
  const asset = adapter.assets[0].symbol;
  const treasury = treasuryPair(mnemonic);
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
