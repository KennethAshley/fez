import { generateWalletMnemonic, deriveAgentPair, treasuryPair, pairFromStored, deriveAgentEvm } from "./derive.js";
import { readEntry, writeEntry, readRootEntry, writeRootEntry, readRemoteHotkeyEntry, writeRemoteHotkeyEntry } from "./store.js";
import { isValidEntryName, isReservedEntryName } from "./entry-names.js";
import { loadConfig, saveConfig, assignEvmIndex, migratePrefs, x402Settings, type Network } from "./config.js";
import { NETWORKS } from "./networks.js";
import { type ChainAdapter, parseAmount, formatAmount } from "./chains/adapter.js";
import { mirrorAddresses, mirrorEndpoint, mirrorSpend, mirrorPrefs, mirrorEvmAddress, mirrorX402Meta, mirrorSubnet } from "./storage-mirror.js";
import { migrateLog } from "./log.js";
import { burnCost, formatRao, ownerOf, register, stakedAlpha, transferStake, uidFor } from "./chains/subtensor.js";
import { TAO_DECIMALS } from "./chains/substrate.js";
import { DEFAULT_NETUID, personaStatus, requirePersonaPair, requireRehearsalNetwork, subtensorFor } from "./stake.js";

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

/**
 * Settle a hire FROM THE TREASURY — the human's main account, which the
 * root-free `pay` (rent.ts) can't sign for. This lives here because the
 * treasury is the root's to sign, and only a human-at-the-desktop path
 * reaches it (the DM settle invokes the CLI, never mcp). Same shape as a
 * persona pay: transfer + a ledger entry the wallet panel shows.
 */
export async function payFromTreasury(
  adapter: ChainAdapter,
  to: string,
  amount: string,
  opts: { memo?: string } = {},
): Promise<{ persona: string; to: string; amount: string; txHash: string }> {
  const config = loadConfig();
  requireRehearsalNetwork(config.network);
  if (!/^5[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(to)) throw new Error("recipient must be an ss58 address");
  const mnemonic = requireRoot();
  const parsed = parseAmount(amount, adapter.assets[0].decimals, adapter.assets[0].symbol);
  const { txHash } = await adapter.transfer(treasuryPair(mnemonic), to, parsed);
  await mirrorSpend({
    ts: new Date().toISOString(),
    persona: "treasury", to, amount, asset: adapter.assets[0].symbol, txHash,
    memo: opts.memo ?? "hire", consent: "approved", network: config.network,
  });
  return { persona: "treasury", to, amount, txHash };
}

/* ── stake rehearsal (spec 2026-09-03) ──────────────────────────────────
 * Register lives HERE because the treasury signs the burn, and the root
 * mnemonic is this module's to hold. Stake/unstake/status are persona-only
 * and live in stake.ts, importable by mcp.ts (whose import graph must
 * never reach readRootEntry) — the agent stakes itself; the guardian
 * registers it. */
export { stakePersona, unstakePersona, personaStatus, type StakeResult, type PersonaChainStatus } from "./stake.js";

export interface RegisterResult {
  persona: string;
  netuid: number;
  uid: number;
  hotkey: string;
  /** Present when this call actually burned — absent means adopted. */
  txHash?: string;
  burned?: string;
  adopted?: boolean;
}

/**
 * `opts.hotkeyAddress`, when given, registers THAT address instead of the
 * derived pair's — the standalone-remote-hotkey path (see
 * exportRemoteHotkey below): the signing key lives on a rented machine,
 * never in this keychain, so there is no local persona pair to derive an
 * address from. The treasury still signs the burn either way (requireRoot
 * always runs) — only the address being registered/adopted changes.
 */
export async function registerPersona(
  persona: string,
  netuid = DEFAULT_NETUID,
  opts?: { hotkeyAddress?: string }
): Promise<RegisterResult> {
  const hotkey = opts?.hotkeyAddress ?? requirePersonaPair(persona).address;
  const mnemonic = requireRoot();
  const config = loadConfig();
  requireRehearsalNetwork(config.network);
  const api = await subtensorFor(config.endpoints.tao);

  const existing = await uidFor(api, netuid, hotkey);
  if (existing !== undefined) {
    // Idempotent adopt: already registered (a re-click, or a pre-wipe uid
    // that survived) — record it and report, never a refusal.
    await mirrorSubnet({ name: persona, entry: { netuid, uid: existing, hotkey } });
    return { persona, netuid, uid: existing, hotkey, adopted: true };
  }

  const burn = await burnCost(api, netuid);
  const { txHash, uid } = await register(api, treasuryPair(mnemonic), hotkey, netuid);
  if (uid === undefined) throw new Error("registration landed but the uid did not resolve — run: fez-wallet status " + persona);
  await mirrorSubnet({ name: persona, entry: { netuid, uid, hotkey } });
  return { persona, netuid, uid, hotkey, txHash, burned: formatRao(burn) };
}

/**
 * A standalone remote-signing key: a FRESH mnemonic, unrelated to the
 * treasury tree (no //<persona> derivation — the money tree's whole point
 * is a hard path that can't be climbed back to the parent, which is
 * backwards here: this key must stand alone so leaking it never exposes
 * the treasury). Stored under its own namespaced entry
 * (remote-hotkey/<persona>, via store.ts's sibling helpers) — the root
 * entry is never touched by this path. Create-or-load: idempotent, so
 * re-running `export-hotkey` after the first time re-exports the same key.
 */
export async function exportRemoteHotkey(
  persona: string
): Promise<{ persona: string; ss58Address: string; keyfile: ReturnType<typeof keyfileFor>; created: boolean }> {
  requireUsablePersonaName(persona);
  const existing = readRemoteHotkeyEntry(persona);
  const mnemonic = existing ?? generateWalletMnemonic();
  if (!existing) writeRemoteHotkeyEntry(persona, mnemonic);
  const keyfile = keyfileFor(mnemonic);
  return { persona, ss58Address: keyfile.ss58Address, keyfile, created: !existing };
}

/**
 * Shapes a bittensor-loadable keyfile from a BARE mnemonic (no derivation
 * path — this IS the key, not a branch of a tree). Field set pinned
 * against opentensor/btwallet's src/keyfile.rs (fetched 2026-09-07,
 * serialized_keypair_to_keyfile_data / deserialize_keypair_from_keyfile_data):
 * the loader tries `secretPhrase` first (falls back to `secretSeed`, then
 * `privateKey`, then a watch-only `ss58Address`-only entry), and defaults
 * `cryptoType` to sr25519 when the field is absent — so `secretPhrase` +
 * `ss58Address` alone is a complete, sr25519 load path; no mini-secret or
 * explicit cryptoType needed. `accountId` and `publicKey` are both written
 * as the same 0x-prefixed hex of the public key by the Rust serializer —
 * kept identical here for the same reason (some readers key off one name,
 * some the other; only `secretPhrase`'s presence actually reconstructs
 * the signing keypair, the rest is display/matching).
 */
export function keyfileFor(mnemonic: string): {
  accountId: string;
  publicKey: string;
  secretPhrase: string;
  ss58Address: string;
} {
  const pair = treasuryPair(mnemonic); // bare pair: sr25519 from the mnemonic directly, no //path
  const publicKey = `0x${pair.publicKeyHex}`;
  return { accountId: publicKey, publicKey, secretPhrase: mnemonic, ss58Address: pair.address };
}

export async function cmdRegister(io: CliIo, persona: string, netuid = DEFAULT_NETUID): Promise<void> {
  const api = await subtensorFor(loadConfig().endpoints.tao).catch(() => undefined);
  if (api) io.print(`registration on netuid ${netuid} burns ${formatRao(await burnCost(api, netuid))} tTAO from the treasury`);
  const r = await registerPersona(persona, netuid);
  if (r.adopted) io.print(`${persona} was already registered — adopted uid ${r.uid} on netuid ${r.netuid}`);
  else io.print(`registered ${persona}: uid ${r.uid} on netuid ${r.netuid} (burned ${r.burned} tTAO, tx ${r.txHash})`);
}

export interface CostResult {
  netuid: number;
  rao: string;
  tao: string;
}

/** Pure shaping so the gui's json contract is testable without a chain. */
export function costResult(netuid: number, rao: bigint): CostResult {
  return { netuid, rao: rao.toString(), tao: formatRao(rao) };
}

/** Read-only: what registering on netuid would burn, before anyone pays it.
 * Never touches the root mnemonic or signs anything — just an api read. */
export async function registrationCost(netuid = DEFAULT_NETUID): Promise<CostResult> {
  const api = await subtensorFor(loadConfig().endpoints.tao);
  return costResult(netuid, await burnCost(api, netuid));
}

export async function cmdCost(io: CliIo, netuid = DEFAULT_NETUID): Promise<void> {
  const r = await registrationCost(netuid);
  io.print(`netuid ${r.netuid}: registration burn ${r.tao} tTAO`);
}

export interface PayoutResult {
  persona: string;
  netuid: number;
  amount: string;
  txHash: string;
}

/**
 * The guardian's sweep (custody option 2): emissions land in the
 * TREASURY's stake entry on the agent's hotkey, because the treasury
 * registered the uid and the chain credits the owner. Payout transfers
 * that earned alpha to the agent's OWN coldkey — same hotkey, same
 * netuid, still staked; only the name on the account changes. This is
 * what makes "the agent stakes its own earnings" literally true while
 * the guardian keeps the uid.
 */
export async function payoutPersona(persona: string, amount?: string, netuid = DEFAULT_NETUID): Promise<PayoutResult> {
  const pair = requirePersonaPair(persona);
  const mnemonic = requireRoot();
  const config = loadConfig();
  requireRehearsalNetwork(config.network);
  const api = await subtensorFor(config.endpoints.tao);
  const treasury = treasuryPair(mnemonic);

  // Sanity before signing: the sweep only makes sense from the coldkey the
  // chain actually credits. A hotkey the agent owns itself has no guardian
  // entry — its earnings already land under its own name.
  const owner = await ownerOf(api, pair.address);
  if (owner !== treasury.address) {
    throw new Error(
      owner === pair.address
        ? `${persona} owns its own hotkey — emissions already land under its name, nothing to sweep`
        : `${persona}'s hotkey is owned by ${owner}, not this treasury — this wallet cannot sweep it`
    );
  }
  const earned = await stakedAlpha(api, netuid, pair.address, treasury.address);
  if (earned === undefined) throw new Error("the chain would not report the earned balance — try again");
  if (earned === 0n) throw new Error(`${persona} has no earned alpha to pay out yet — emissions accrue after its uid receives weights`);

  const requested = amount !== undefined ? parseAmount(amount, TAO_DECIMALS, "TAO").raw : earned;
  if (requested > earned) {
    throw new Error(`${persona} has earned ${formatRao(earned)} tα; paying out ${amount} is more than that`);
  }
  const { txHash } = await transferStake(api, treasury, {
    destinationColdkey: pair.address,
    hotkey: pair.address,
    netuid,
    amountRao: requested,
  });
  return { persona, netuid, amount: formatRao(requested), txHash };
}

export async function cmdPayout(io: CliIo, persona: string, amount?: string, netuid = DEFAULT_NETUID): Promise<void> {
  const r = await payoutPersona(persona, amount, netuid);
  io.print(`paid out ${r.amount} tα to ${persona}'s own name — still staked behind its hotkey (tx ${r.txHash})`);
}

export async function cmdPersonaStatus(io: CliIo, persona: string, netuid = DEFAULT_NETUID): Promise<void> {
  const s = await personaStatus(persona, netuid);
  const t = s.network === "finney" ? "" : "t";
  io.print(`${s.persona}  ${s.address}`);
  io.print(`netuid ${s.netuid}: ${s.uid !== undefined ? `uid ${s.uid}` : "not registered"}`);
  const eq = s.staked !== undefined && s.alphaPriceTao !== undefined && s.alphaPriceTao > 0
    ? ` ≈ ${(Number(s.staked) * s.alphaPriceTao).toFixed(2)} ${t}TAO`
    : "";
  io.print(`free ${s.free} ${t}TAO · staked ${s.staked !== undefined ? `${s.staked} ${t}α${eq}` : "unknown"}`);
  if (s.earned !== undefined) {
    io.print(`earned ${s.earned} ${t}α held by the treasury — sweep with: fez-wallet payout ${s.persona}`);
  }
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
