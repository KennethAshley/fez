import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WalletConfig {
  thresholds: Record<string, string>; // TAO strings; "default" is the floor
  consentChannel?: string;            // channelId consent requests post to
  personas: Record<string, { index: number }>; // stable EVM derivation indexes
  endpoints: { tao: string };
}

const DEFAULTS: WalletConfig = {
  thresholds: { default: "0.01" },
  personas: {},
  endpoints: { tao: "wss://entrypoint-finney.opentensor.ai:443" },
};

function configFile(): string {
  return path.join(process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez"), "wallet.json");
}

export function loadConfig(): WalletConfig {
  try {
    const onDisk = JSON.parse(fs.readFileSync(configFile(), "utf-8"));
    return {
      ...DEFAULTS,
      ...onDisk,
      thresholds: { ...DEFAULTS.thresholds, ...onDisk.thresholds },
      endpoints: { ...DEFAULTS.endpoints, ...onDisk.endpoints },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(c: WalletConfig): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
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
