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
}

const DEFAULTS: WalletConfig = {
  thresholds: { default: "0.01" },
  personas: {},
  endpoints: { tao: "wss://entrypoint-finney.opentensor.ai:443" },
  network: "finney",
};

const ENDPOINTS: Record<Network, string> = {
  finney: "wss://entrypoint-finney.opentensor.ai:443",
  test: "wss://test.finney.opentensor.ai:443",
};

export function endpointFor(network: Network): string {
  return ENDPOINTS[network];
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
    // An explicit endpoint always wins — local nodes and forks need it.
    endpoints: { tao: onDisk.endpoints?.tao ?? endpointFor(network) },
  };
}

export function saveConfig(c: WalletConfig): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
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

export function assignEvmIndex(c: WalletConfig, persona: string): number {
  const existing = c.personas[persona];
  if (existing) return existing.index;
  const used = new Set(Object.values(c.personas).map((p) => p.index));
  let i = 0;
  while (used.has(i)) i++;
  c.personas[persona] = { index: i };
  return i;
}
