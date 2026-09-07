/**
 * The MINER surface — how a subnet extension teaches fez to mine its
 * subnet. A `parts.miner` module default-exports SubnetMiner[]; the
 * install places it in ~/.fez/miners/<name>.js and the mining harness
 * (fez-mining) loads every file in that dir.
 *
 * The harness owns what is the same for every subnet: chain
 * registration (burnedRegister via fez-wallet), process supervision,
 * restart, and the GUI. A descriptor owns only what is subnet-specific.
 */

/** What the harness hands every verb. */
export interface MinerContext {
  /** Absolute dir this miner may write — venv, checkout, logs. Created by the harness. */
  workDir: string;
  /** The mining persona's name (its derived account IS the hotkey). */
  persona: string;
  /** The hotkey's ss58 address. */
  hotkey: string;
  netuid: number;
  /** Extra env the harness was configured with for this miner. */
  env: Record<string, string>;
  /** Append a line to the miner's log (harness tees to file + stdout). */
  log(line: string): void;
}

export interface MinerStatus {
  running: boolean;
  detail?: string;
}

export interface SubnetMiner {
  netuid: number;
  /** Short human name shown in the GUI row ("bazaar"). */
  name: string;
  requirements?: { gpu?: string; ramGb?: number; diskGb?: number; alwaysOn?: boolean };
  /** One-time machine setup (clone, deps). MUST be idempotent — the runner calls it every start. */
  install?(ctx: MinerContext): Promise<void>;
  /**
   * Subnet-specific enrollment AFTER chain registration (the harness has
   * already burnedRegister'd the hotkey when this runs) — e.g. the
   * bazaar's npub↔hotkey binding. Called once per (netuid, persona);
   * the harness records completion in a flag file.
   */
  register?(ctx: MinerContext): Promise<void>;
  /** Run the miner. Resolves only when mining stops; the harness supervises the process around it. */
  start(ctx: MinerContext): Promise<void>;
  /** Graceful stop; the harness kills the process if this is absent or hangs. */
  stop?(ctx: MinerContext): Promise<void>;
  /** Subnet-side health beyond process-alive. */
  status?(ctx: MinerContext): Promise<MinerStatus>;
}
