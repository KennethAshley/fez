import { generateWalletMnemonic, deriveAgentPair, treasuryPair, pairFromStored, deriveAgentEvm } from "./derive.js";
import { readEntry, writeEntry, readRootEntry, writeRootEntry } from "./store.js";
import { isValidEntryName, isReservedEntryName } from "./entry-names.js";
import { loadConfig, saveConfig, assignEvmIndex, migratePrefs, x402Settings, type Network } from "./config.js";
import { NETWORKS } from "./networks.js";
import { type ChainAdapter, parseAmount, formatAmount } from "./chains/adapter.js";
import { mirrorAddresses, mirrorEndpoint, mirrorSpend, mirrorPrefs, mirrorEvmAddress, mirrorX402Meta } from "./storage-mirror.js";
import { migrateLog } from "./log.js";

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

/** The ceremony, as data — ONE implementation for both presentations
 * (the CLI's prose and `--json` for the wallet panel's in-app flow).
 * The mnemonic is returned exactly once, by init alone; nothing else
 * ever reads it back out. */
export type InitResult =
  | { adopted?: undefined; mnemonic: string; treasuryAddress: string }
  | { adopted: true; treasuryAddress: string };

export async function initWallet(): Promise<InitResult> {
  // An existing root is ADOPTED, never overwritten: rebuild the mirror
  // from it and hand back the treasury. This is the repair path for the
  // stranded half-state (root in the keychain, mirror wiped — factory
  // reset or a fresh machine) that used to dead-end wallet setup.
  const existing = readRootEntry();
  if (existing) {
    const treasuryAddress = treasuryPair(existing).address;
    await mirrorAddresses({ treasury: treasuryAddress });
    const config = loadConfig();
    await mirrorEndpoint(config.endpoints.tao, config.network);
    return { adopted: true, treasuryAddress };
  }
  const mnemonic = generateWalletMnemonic();
  writeRootEntry(mnemonic);
  const treasuryAddress = treasuryPair(mnemonic).address;
  await mirrorAddresses({ treasury: treasuryAddress });
  const config = loadConfig();
  await mirrorEndpoint(config.endpoints.tao, config.network);
  return { mnemonic, treasuryAddress };
}

export async function cmdInit(io: CliIo): Promise<void> {
  const result = await initWallet();
  if (result.adopted) {
    io.print("an existing wallet root was found and reconnected — nothing was overwritten.");
    io.print(`treasury address: ${result.treasuryAddress}`);
    io.print("agent accounts derive from it as before: fez-wallet derive <persona>");
    return;
  }
  io.print("wallet created. WRITE THESE 24 WORDS DOWN — they are shown exactly once:");
  io.print("");
  io.print(`  ${result.mnemonic}`);
  io.print("");
  io.print(`treasury address: ${result.treasuryAddress}`);
  io.print("fund the treasury, then: fez-wallet derive <persona> && fez-wallet fund <persona> <amount>");
}

export interface DeriveResult {
  persona: string;
  address: string;
  evmAddress: string;
}

export async function derivePersona(persona: string): Promise<DeriveResult> {
  requireUsablePersonaName(persona);
  const mnemonic = requireRoot();
  const existing = readEntry(persona);
  const pair = existing ? pairFromStored(existing) : deriveAgentPair(mnemonic, persona);
  const config = loadConfig();
  const evmIndex = assignEvmIndex(config, persona);
  saveConfig(config);
  // Same stored-pair mechanism as the sr25519 half (one JSON entry per
  // persona) — rewritten every call so a pre-EVM entry gets backfilled,
  // idempotently, since both halves are deterministic from mnemonic+index.
  const evm = deriveAgentEvm(mnemonic, evmIndex);
  writeEntry(persona, JSON.stringify({ ...pair, evm }));
  await finishDeriveMirrors(persona, pair.address, evm.addressHex, config);
  return { persona, address: pair.address, evmAddress: evm.addressHex };
}

async function finishDeriveMirrors(persona: string, address: string, evmAddress: string, config: ReturnType<typeof loadConfig>): Promise<void> {
  await mirrorAddresses({ persona: { name: persona, address } });
  // The panel shows the fundable EVM address + the effective x402 settings.
  await mirrorEvmAddress({ name: persona, address: evmAddress });
  {
    const s = x402Settings(config);
    await mirrorX402Meta({ network: s.network, rpcUrl: s.rpcUrl, usdcAddress: s.usdcAddress, dailyCapUsd: s.dailyCapUsd, autoApproveDefault: s.autoApproveUnderUsd.default ?? 0 });
  }
}

export async function cmdDerive(io: CliIo, persona: string): Promise<void> {
  const r = await derivePersona(persona);
  io.print(`${r.persona}: ${r.address}`);
  io.print(`${r.persona} (evm): ${r.evmAddress}  (fund this for x402 payments)`);
}

/** The only path that changes which chain the wallet talks to. An unknown
 * network is rejected before ANY side effect — including the one-time
 * migration — so `fez-wallet network mainnet` on a real disk with a legacy
 * wallet.json never mutates anything on the way to throwing. Prefs write
 * first; loadConfig() is re-read from disk afterward so what we print is
 * what is now actually persisted, not what we assume. */
export async function cmdNetwork(io: CliIo, next?: string): Promise<void> {
  if (next !== undefined && !NETWORKS.includes(next as Network)) {
    throw new Error(`unknown network "${next}" — expected one of: ${NETWORKS.join(", ")}`);
  }
  migratePrefs();
  migrateLog();
  if (!next) {
    const c = loadConfig();
    io.print(`network: ${c.network}${c.network === "finney" ? "" : "  ⚠️  play money"}`);
    io.print(`endpoint: ${c.endpoints.tao}`);
    return;
  }
  await mirrorPrefs({ network: next as Network });
  const c = loadConfig();
  await mirrorEndpoint(c.endpoints.tao, c.network);
  io.print(`network: ${c.network}${c.network === "finney" ? "" : "  ⚠️  play money"}`);
  io.print(`endpoint: ${c.endpoints.tao}`);
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
  await mirrorEndpoint(config.endpoints.tao, config.network);
  io.print(`network: ${config.network}${config.network === "finney" ? "" : "  ⚠️  play money"}`);
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
