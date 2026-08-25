import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SpendEntry {
  ts: string;
  persona: string;
  to: string;
  amount: string;
  asset: string;
  txHash: string;
  memo?: string;
  consent: "auto" | "approved";
}

function logFile(): string {
  return path.join(process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez"), "wallet-log.jsonl");
}

export function appendLog(entry: SpendEntry): void {
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function readLog(limit: number): SpendEntry[] {
  try {
    const lines = fs.readFileSync(logFile(), "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as SpendEntry);
  } catch {
    return [];
  }
}
