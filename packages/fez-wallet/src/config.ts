import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WalletPrefs } from "./storage-mirror.js";
import { adoptLegacyStorage, storageDir, STORAGE_NAME } from "./storage-mirror.js";
import { type Network, endpointFor, isNetworkOwnedEndpoint, networkFromEndpoint } from "./networks.js";

export type { Network, WalletPrefs };
export { endpointFor };

export interface WalletConfig {
  thresholds: Record<string, string>; // TAO strings; "default" is the floor
  consentChannel?: string;            // channelId consent requests post to
  personas: Record<string, { index: number }>; // stable EVM derivation indexes
  endpoints: { tao: string };
  network: Network;
  knownPayees: string[]; // payee pubkeys that have been approved at least once
  x402?: Partial<X402Settings>; // wallet.json-owned — see x402Settings() below
}

/** USDC on base-sepolia — the only x402 asset wired up today. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Base MAINNET USDC, verified against Circle's official contract-address
 * docs on 2026-08-30 (https://developers.circle.com/stablecoins/usdc-contract-addresses).
 * Not used by default — flipping x402.network to "base" (and chainRef to
 * "eip155:8453") in wallet.json is the whole enablement, no code change. */
export const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface X402Settings {
  network: string;   // human label, e.g. "base-sepolia" / "base"
  chainRef: string;  // matches an offer's `network` field, e.g. "eip155:84532"
  usdcAddress: string;
  autoApproveUnderUsd: Record<string, number>; // "default" is the floor; 0 = always ask
  dailyCapUsd: number;
  rpcUrl: string;
}

const X402_DEFAULTS: X402Settings = {
  network: "base-sepolia",
  chainRef: "eip155:84532",
  usdcAddress: USDC_BASE_SEPOLIA,
  autoApproveUnderUsd: { default: 0 },
  dailyCapUsd: 25,
  rpcUrl: "https://sepolia.base.org",
};

/** network -> the chain facts that follow from it, so "flip the network"
 * (the README's promise) is literally one field. Only two rows exist
 * today; an unrecognised `network` string falls back to base-sepolia's
 * row rather than refusing outright — the same "an override still wins"
 * shape `chainRef`/`usdcAddress`/`rpcUrl` keep below regardless. USDC
 * addresses verified against Circle's official contract-address docs,
 * 2026-08-30 (developers.circle.com/stablecoins/usdc-contract-addresses). */
const X402_NETWORK_TABLE: Record<string, { chainRef: string; usdcAddress: string; rpcUrl: string }> = {
  "base-sepolia": { chainRef: "eip155:84532", usdcAddress: USDC_BASE_SEPOLIA, rpcUrl: "https://sepolia.base.org" },
  base: { chainRef: "eip155:8453", usdcAddress: USDC_BASE_MAINNET, rpcUrl: "https://mainnet.base.org" },
};

/**
 * Two homes, combined only at READ time: wallet.json's `x402` block is the
 * CLI/hand-edited base layer; `prefs.x402` is the GUI-editable layer and
 * wins key-by-key. The thresholds round-trip bug this file's comments warn
 * about came from COPYING prefs values into wallet.json on save — that
 * cannot recur here because saveConfig never sees prefs.x402 and so never
 * persists it.
 *
 * The one non-obvious rule: a prefs-level `network` flip re-derives
 * chainRef/usdcAddress/rpcUrl from the table AND ignores wallet.json's
 * explicit overrides of those three — otherwise a GUI flip to mainnet
 * could pair mainnet's chain id with a stale sepolia contract (the
 * "session says testnet, spends mainnet" bug class the TAO wallet was
 * burned by; see isNetworkOwnedEndpoint's history). Prefs' own explicit
 * overrides still win over its derived row.
 */
export function x402Settings(c: WalletConfig, prefs: WalletPrefs = readPrefs()): X402Settings {
  const disk = c.x402 ?? {};
  const p = prefs.x402 ?? {};
  const prefsFlipped = p.network !== undefined;
  const network = p.network ?? disk.network ?? X402_DEFAULTS.network;
  const derived = X402_NETWORK_TABLE[network] ?? X402_NETWORK_TABLE[X402_DEFAULTS.network];

  // Chain facts: prefs override > (disk override, unless a prefs flip
  // invalidated it) > the network's derived row.
  const chain = (key: "chainRef" | "usdcAddress" | "rpcUrl"): string =>
    p[key] ?? (prefsFlipped ? derived[key] : disk[key] ?? derived[key]);

  // A NaN/Infinity in either layer (hand-edited or GUI-garbled) must not
  // silently fail OPEN: dailyCapUsd and autoApproveUnderUsd both feed `>`
  // comparisons that never trip against NaN — every payment would
  // auto-approve with no cap. Bad values fall through to the next layer.
  const finite = (v: unknown): number | undefined => (Number.isFinite(v) ? (v as number) : undefined);
  const dailyCapUsd = finite(p.dailyCapUsd) ?? finite(disk.dailyCapUsd) ?? X402_DEFAULTS.dailyCapUsd;
  const autoApproveUnderUsd: Record<string, number> = { ...X402_DEFAULTS.autoApproveUnderUsd };
  for (const layer of [disk.autoApproveUnderUsd, p.autoApproveUnderUsd]) {
    for (const [persona, v] of Object.entries(layer ?? {})) {
      if (Number.isFinite(v)) autoApproveUnderUsd[persona] = v as number;
    }
  }

  return {
    network,
    chainRef: chain("chainRef"),
    usdcAddress: chain("usdcAddress"),
    rpcUrl: chain("rpcUrl"),
    dailyCapUsd,
    autoApproveUnderUsd,
  };
}

const DEFAULTS: WalletConfig = {
  thresholds: { default: "0.01" },
  personas: {},
  endpoints: { tao: endpointFor("finney") },
  network: "finney",
  knownPayees: [],
};

/** Sync merge into the prefs subtree. saveConfig needs this to migrate a
 * legacy pin in the same breath as stripping it; the async storage-mirror
 * queue is for the gui/CLI paths that are already async. */
function writePrefsSync(p: Partial<WalletPrefs>): void {
  const file = prefsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* empty */ }
  state.prefs = { ...(state.prefs as WalletPrefs ?? {}), ...p };
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function configFile(): string {
  return path.join(process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez"), "wallet.json");
}

function prefsFile(): string {
  // Same file the mirror writes and the panel reads (see storage-mirror
  // STORAGE_NAME + the legacy adoption) — prefs written by the GUI land
  // here, so this MUST be the adopted name or GUI settings are ignored.
  adoptLegacyStorage();
  return path.join(storageDir(), `${STORAGE_NAME}.json`);
}

/** Sync because loadConfig() is sync and runs per tool call. Writes go
 * through storage-mirror's queue; this only ever reads. */
export function readPrefs(): WalletPrefs {
  try {
    return (JSON.parse(fs.readFileSync(prefsFile(), "utf-8")).prefs ?? {}) as WalletPrefs;
  } catch {
    return {};
  }
}

export function loadConfig(): WalletConfig {
  let onDisk: Partial<WalletConfig> & { endpoints?: { tao?: string } } = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(configFile(), "utf-8"));
  } catch { /* missing/corrupt reads as defaults */ }
  const prefs = readPrefs();
  // prefs first; then a legacy pin, which is the only record a pre-prefs
  // wallet has of its network; only then the default. Inference applies
  // solely when prefs are silent, so it can never override a live choice.
  const network: Network =
    prefs.network ?? networkFromEndpoint(onDisk.endpoints?.tao) ?? "finney";
  return {
    ...DEFAULTS,
    ...onDisk,
    network,
    // prefs wins; wallet.json's thresholds are legacy until migratePrefs runs.
    thresholds: { ...DEFAULTS.thresholds, ...onDisk.thresholds, ...prefs.thresholds },
    // Only an UNRECOGNISED endpoint wins — local nodes and forks need that,
    // and nothing else could have put it there. A recognised one is a
    // legacy pin from before saveConfig stopped writing derived state
    // (every `fez-wallet derive` wrote one); honouring it would let the
    // network label move while the socket stayed on the old chain — a
    // session that says testnet everywhere and spends real TAO. migratePrefs
    // heals such a file, but it only runs from `fez-wallet network`, and the
    // panel flips the network without it.
    endpoints: {
      tao: isNetworkOwnedEndpoint(onDisk.endpoints?.tao)
        ? endpointFor(network)
        : onDisk.endpoints?.tao ?? endpointFor(network),
    },
  };
}

/**
 * wallet.json holds ONLY what the ceremony owns — personas, knownPayees,
 * consentChannel, and a genuinely explicit endpoint. Everything loadConfig()
 * *derives* is stripped on the way out, because saveConfig is reached by two
 * ordinary paths (`fez-wallet derive`, and rememberPayee after the first
 * approved payee) that hand back the object loadConfig() just built.
 *
 * Writing that object verbatim turned derived state into a permanent
 * explicit override: `endpoints.tao` — filled in from the ACTIVE network —
 * became a pin that "an explicit endpoint always wins" then honoured
 * forever. Flipping prefs to "test" afterwards moved `network` (the guard,
 * the ledger filename, the "play money" label and the consent card) while
 * the socket stayed on finney: a session that says testnet everywhere and
 * spends real TAO. The same write leaked prefs' thresholds into wallet.json,
 * so a loosened threshold survived deleting prefs (spec §6 promises the
 * opposite).
 *
 * The rule both strips share: drop anything loadConfig() would have supplied
 * on its own; keep only what it could not have.
 */
export function saveConfig(c: WalletConfig): void {
  const prefs = readPrefs();

  // Migrate before stripping. `derive` and the first-approved-payee write
  // both land here holding an object loadConfig() built, and the strip below
  // removes a recognised endpoint — which for a pre-prefs wallet is the only
  // thing recording its network. Removing it without moving it first returned
  // such a wallet to the finney default silently, mid-command: `fez-wallet
  // derive quill` on a testnet wallet moved it to mainnet and said nothing.
  if (prefs.network === undefined) {
    let pinned: string | undefined;
    try { pinned = JSON.parse(fs.readFileSync(configFile(), "utf-8")).endpoints?.tao; } catch { /* none */ }
    const inferred = networkFromEndpoint(pinned);
    if (inferred) {
      writePrefsSync({ network: inferred });
      prefs.network = inferred;
    }
  }
  const { network: _derivedNetwork, endpoints, thresholds, ...owned } = c;
  const persisted: Record<string, unknown> = { ...owned };

  // A recognised network endpoint is network-owned, exactly as loadConfig
  // and migratePrefs treat it — only an endpoint no network maps to (a local
  // node, a fork) is a real override, and that one still survives and wins.
  const keptEndpoints: Record<string, string> = { ...(endpoints as Record<string, string> | undefined) };
  if (keptEndpoints.tao === undefined || isNetworkOwnedEndpoint(keptEndpoints.tao)) delete keptEndpoints.tao;
  if (Object.keys(keptEndpoints).length > 0) persisted.endpoints = keptEndpoints;

  // Thresholds prefs owns, or that are just the default echoed back, are
  // dropped; a per-persona threshold that lives only in wallet.json stays.
  const kept = Object.entries(thresholds ?? {}).filter(
    ([k, v]) => prefs.thresholds?.[k] === undefined && DEFAULTS.thresholds[k] !== v
  );
  if (kept.length > 0) persisted.thresholds = Object.fromEntries(kept);

  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(persisted, null, 2) + "\n", { mode: 0o600 });
}

/** One-time move of user-settable fields into prefs (spec §6: one home
 * per field). An endpoint that exactly matches a known network becomes
 * that network — otherwise the panel's selector could never move it. An
 * unrecognised endpoint is left alone: it is a deliberate override. */
export function migratePrefs(): void {
  const onDisk = (() => {
    try { return JSON.parse(fs.readFileSync(configFile(), "utf-8")); }
    catch { return undefined; }
  })();
  if (!onDisk) return;
  const moved: WalletPrefs = {};
  if (onDisk.thresholds) {
    moved.thresholds = onDisk.thresholds;
    delete onDisk.thresholds;
  }
  const known = networkFromEndpoint(onDisk.endpoints?.tao);
  if (known) {
    moved.network = known;
    delete onDisk.endpoints.tao;
    if (Object.keys(onDisk.endpoints).length === 0) delete onDisk.endpoints;
  }
  if (Object.keys(moved).length === 0) return;
  const existing = readPrefs();
  const file = prefsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* empty */ }
  state.prefs = { ...moved, ...existing }; // an existing pref already won
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  saveConfig(onDisk as WalletConfig);
}

export function thresholdFor(c: WalletConfig, persona: string): string {
  return c.thresholds[persona] ?? c.thresholds.default;
}

/** A payee is remembered only after an owner approves a payment to them —
 * never on decline or timeout, which would silently authorize every
 * future payment to that pubkey. Keyed on the pubkey, never the name:
 * two owners can each run an agent called "chip", and keying on the name
 * would let the second one inherit the first one's approval. */
export function rememberPayee(c: WalletConfig, pubkey: string): void {
  if (!c.knownPayees.includes(pubkey)) c.knownPayees = [...c.knownPayees, pubkey];
}

/** Smallest-unused is only safe while personas never shrink: if an entry
 * were ever deleted from `c.personas`, its index would look "unused" again
 * and get handed to the NEXT new persona — who would inherit whatever
 * balance the old, deleted persona's key still held. Nothing today deletes
 * a persona entry; if that ever changes, indexes must be retired, not
 * reused. */
export function assignEvmIndex(c: WalletConfig, persona: string): number {
  const existing = c.personas[persona];
  if (existing) return existing.index;
  const used = new Set(Object.values(c.personas).map((p) => p.index));
  let i = 0;
  while (used.has(i)) i++;
  c.personas[persona] = { index: i };
  return i;
}
