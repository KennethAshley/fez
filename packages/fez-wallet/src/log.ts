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

/**
 * The x402 spend log — a separate append-only stream from the TAO
 * `wallet-log.*.jsonl` above: x402 runs on its own chain family (the
 * `network` here is an x402 label like "base-sepolia", not the substrate
 * `Network` type wallet-log is keyed by) and needs a `status` a plain
 * transfer never has. `dir` is passed explicitly, same seam as
 * x402.ts's todaySpend/recordSpend, so tests never touch FEZ_WALLET_HOME.
 *
 * Append-only, like the tally: a payment's lifecycle (signed → settled,
 * or signed → ambiguous) is recorded as a NEW row rather than an
 * in-place update, so "what happened" is never lost by being overwritten.
 */
export interface X402LogEntry {
  ts: string;
  persona: string;
  url: string;
  payTo: string;
  usd: number;
  status: "signed" | "settled" | "ambiguous";
  txHash?: string;
  network: string;
}

export function appendX402Log(dir: string, entry: X402LogEntry): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "x402-log.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function readX402Log(dir: string, limit = 20): X402LogEntry[] {
  try {
    const lines = fs.readFileSync(path.join(dir, "x402-log.jsonl"), "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as X402LogEntry);
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
