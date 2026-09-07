import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export interface Subnet {
  netuid: number;
  name: string;
  description: string;
  github: string;
  url: string;
  contact: string;
  discord: string;
}

export interface MinerEntry {
  netuid: number;
  persona: string;
  hotkey: string;
  uid?: number;
  desired: "running" | "stopped";
  pid?: number;
  startedAt?: number;
  lastExit?: string;
}
export interface MiningState { miners: MinerEntry[]; subnets: Subnet[]; covered: number[] }

export const fezHome = (): string => process.env.FEZ_MINE_HOME || path.join(homedir(), ".fez");
const stateFile = (home: string) => path.join(home, "extension-data", "fez-mining.json");

export async function readState(home = fezHome()): Promise<MiningState> {
  try {
    const raw = JSON.parse(await fs.readFile(stateFile(home), "utf8"));
    return { miners: raw.miners ?? [], subnets: raw.subnets ?? [], covered: raw.covered ?? [] };
  } catch {
    return { miners: [], subnets: [], covered: [] };
  }
}
export async function writeState(home: string, s: MiningState): Promise<void> {
  await fs.mkdir(path.dirname(stateFile(home)), { recursive: true });
  await fs.writeFile(stateFile(home), JSON.stringify(s, null, 2));
}
export const minerKey = (netuid: number, persona: string) => `${netuid}:${persona}`;
export function upsertMiner(s: MiningState, e: MinerEntry): MiningState {
  const rest = s.miners.filter((m) => minerKey(m.netuid, m.persona) !== minerKey(e.netuid, e.persona));
  return { ...s, miners: [...rest, e] };
}
export function removeMiner(s: MiningState, netuid: number, persona: string): MiningState {
  return { ...s, miners: s.miners.filter((m) => minerKey(m.netuid, m.persona) !== minerKey(netuid, persona)) };
}
