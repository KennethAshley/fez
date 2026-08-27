import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Network } from "./storage-mirror.js";

export interface SpendEntry {
  ts: string;
  persona: string;
  to: string;
  amount: string;
  asset: string;
  txHash: string;
  memo?: string;
  consent: "auto" | "approved";
  network: Network;
}

function home(): string {
  return process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez");
}

function logFile(network: Network): string {
  return path.join(home(), `wallet-log.${network}.jsonl`);
}

export function appendLog(entry: SpendEntry): void {
  const file = logFile(entry.network);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function readLog(network: Network, limit: number): SpendEntry[] {
  try {
    const lines = fs.readFileSync(logFile(network), "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as SpendEntry);
  } catch {
    return [];
  }
}

/** The legacy single log holds only testnet rows — verified at planning
 * time (3 rows, all from the 2026-08-26 testnet e2e). Decided by that
 * fact, not by the current config, which has since moved. Refuses to
 * overwrite an existing testnet ledger. */
export function migrateLog(): void {
  const legacy = path.join(home(), "wallet-log.jsonl");
  if (!fs.existsSync(legacy)) return;
  const target = logFile("test");
  if (fs.existsSync(target)) {
    fs.rmSync(legacy);
    return;
  }
  const rows = fs
    .readFileSync(legacy, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ network: "test" as Network, ...(JSON.parse(l) as Omit<SpendEntry, "network">) }));
  fs.writeFileSync(target, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  fs.rmSync(legacy);
}
