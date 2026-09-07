import type { MinerEntry } from "./state.js";

/** Miners that should be respawned: desired running, but the recorded pid is gone. */
export function plan(miners: MinerEntry[], isAlive: (pid?: number) => boolean): MinerEntry[] {
  return miners.filter((m) => m.desired === "running" && !isAlive(m.pid));
}
