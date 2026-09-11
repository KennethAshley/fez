import { execFileSync } from "node:child_process";
import type { SubnetMiner } from "@fezchat/extension-api";
import { assertMinerPreflight } from "./config.js";

export function walletChain(walletBin: string): { network: "test" | "finney"; endpoint: string } {
  const output = execFileSync(walletBin, ["network"], { encoding: "utf8", timeout: 30_000 });
  const network = /^network: (test|finney)\b/m.exec(output)?.[1];
  const endpoint = /^endpoint: (wss?:\/\/\S+)$/m.exec(output)?.[1];
  if ((network !== "test" && network !== "finney") || !endpoint) throw new Error("Cannot determine wallet network and endpoint; refusing mining actions");
  return { network, endpoint };
}

export function preflightMiner(d: SubnetMiner, config: Record<string, string | number | boolean>, walletBin: string): void {
  // The wallet owns network selection. Do not infer it from a subnet number
  // or silently change it to match the descriptor.
  const network = d.network ? walletChain(walletBin).network : undefined;
  assertMinerPreflight(d, config, network);
}
