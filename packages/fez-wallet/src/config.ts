import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Network, WalletPrefs } from "./storage-mirror.js";

export type { Network, WalletPrefs };

export interface WalletConfig {
  thresholds: Record<string, string>; // TAO strings; "default" is the floor
  consentChannel?: string;            // channelId consent requests post to
  personas: Record<string, { index: number }>; // stable EVM derivation indexes
  endpoints: { tao: string };
  network: Network;
  knownPayees: string[]; // payee pubkeys that have been approved at least once
}

const DEFAULTS: WalletConfig = {
  thresholds: { default: "0.01" },
  personas: {},
  endpoints: { tao: "wss://entrypoint-finney.opentensor.ai:443" },
  network: "finney",
  knownPayees: [],
};

const ENDPOINTS: Record<Network, string> = {
  finney: "wss://entrypoint-finney.opentensor.ai:443",
  test: "wss://test.finney.opentensor.ai:443",
};

export function endpointFor(network: Network): string {
  return ENDPOINTS[network];
}

/** A recognised network endpoint is network-owned, never a user override:
 * whoever wrote it was naming a network, and the network's own home is
 * prefs. Only an endpoint no network maps to — a local node, a fork — is a
 * genuine override. Read and write sides share this one rule, so a
 * wallet.json written before the rule existed cannot outlive it. */
function isNetworkOwnedEndpoint(url: string | undefined): boolean {
  return url !== undefined && (Object.values(ENDPOINTS) as string[]).includes(url);
}

function configFile(): string {
  return path.join(process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez"), "wallet.json");
}

function prefsFile(): string {
  const dir =
    process.env.FEZ_EXTENSION_DATA_DIR ?? path.join(os.homedir(), ".fez", "extension-data");
  return path.join(dir, "wallet.json");
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
  const network: Network = prefs.network ?? "finney";
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
  const known = (Object.entries(ENDPOINTS) as [Network, string][])
    .find(([, url]) => url === onDisk.endpoints?.tao);
  if (known) {
    moved.network = known[0];
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

export function assignEvmIndex(c: WalletConfig, persona: string): number {
  const existing = c.personas[persona];
  if (existing) return existing.index;
  const used = new Set(Object.values(c.personas).map((p) => p.index));
  let i = 0;
  while (used.has(i)) i++;
  c.personas[persona] = { index: i };
  return i;
}
