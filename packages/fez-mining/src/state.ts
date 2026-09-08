import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Structural view of @fezchat/bittensor's Subnet (which carries additional fields at runtime)
export interface Subnet {
  netuid: number;
  name: string;
  description?: string;
  github?: string;
}

// Absent = local (v1 shape, still valid). podId is optional because
// `fez-mine start --machine lium` records the intent before the runner
// has provisioned anything — the runner fills podId (and the port/rate
// fields) in once `lium up` returns.
export interface MinerMachineState {
  kind: "lium";
  podId?: string;
  externalIp?: string;
  externalPort?: number;
  hourlyRate?: string;
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
  machine?: MinerMachineState;
}
export interface MiningState { miners: MinerEntry[]; subnets: Subnet[]; covered: number[] }

export const fezHome = (): string => process.env.FEZ_MINE_HOME || path.join(homedir(), ".fez");

// Must match this package's INSTALLED name — the desktop's gui loader
// namespace-locks api.storage to the registered extension name, which is
// the package dir under ~/.fez/packages/. `fez install` de-scopes
// @fezchat/mining to "mining"; `fez link` keeps the source dir's
// "fez-mining". A hardcoded name here is wrong for whichever direction it
// doesn't match — fez-wallet hit this bug live (see its storage-mirror.ts).
// So derive it from where this module actually runs, pure and testable
// with a fabricated path: an installed copy under ~/.fez/packages/<name>/
// names it; a repo checkout's packages/<name>/{src,dist}/ names it the
// same way `fez link` would; anywhere else (fresh dev tree) falls back to
// "fez-mining".
export function storageName(modulePath: string = fileURLToPath(import.meta.url)): string {
  const installed = /\/\.fez\/packages\/([^/]+)\//.exec(modulePath);
  if (installed) return installed[1]!;
  const checkout = /\/packages\/([^/]+)\/(?:src|dist)\//.exec(modulePath);
  if (checkout) return checkout[1]!;
  return "fez-mining";
}

const stateFile = (home: string) => path.join(home, "extension-data", `${storageName()}.json`);

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
