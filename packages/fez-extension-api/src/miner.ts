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

/** A public endpoint mapping on the machine — how a serving miner (an
 *  axon) is reached from the internet. Empty on a local machine. */
export interface MachinePort {
  externalIp: string;
  externalPort: number;
  internalPort: number;
}

/**
 * The machine seam — where a miner's commands actually run. Descriptors
 * call these instead of spawning directly, so one descriptor works on
 * any machine kind whose requirements it fits. "ssh" is the designed-for
 * third member (spec §7), not yet built.
 */
export interface MinerMachine {
  kind: "local" | "lium";
  /** Run a shell command on the machine; resolves when it exits.
   *  `transportError: true` means the CALL to the machine failed to run the
   *  command at all (unreachable/timeout/API hiccup) — distinct from the
   *  command running and exiting non-zero. Callers polling liveness must
   *  retry a transportError, never treat it as the remote process being
   *  dead. Absent/false means the command actually ran; `code` is its real
   *  exit status. */
  exec(cmd: string, opts?: { env?: Record<string, string>; cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string; transportError?: boolean }>;
  /** Copy a local file or directory onto the machine. */
  copy(localPath: string, remotePath: string): Promise<void>;
  ports: MachinePort[];
}

/** What the harness hands every verb. */
export interface MinerContext {
  /** Absolute dir this miner may write — venv, checkout, logs. Lives ON
   *  ctx.machine's filesystem, NOT necessarily the host running the
   *  harness — a rented pod's workDir is a path on that pod, unreachable
   *  from the local disk. The harness creates it (via ctx.machine before
   *  install() ever runs); a descriptor that needs a LOCAL-machine file
   *  moved there must go through ctx.machine.copy, never node:fs directly. */
  workDir: string;
  /** The mining persona's name (its derived account IS the hotkey). */
  persona: string;
  /** The hotkey's ss58 address. */
  hotkey: string;
  netuid: number;
  /** Extra env the harness was configured with for this miner. */
  env: Record<string, string>;
  /** Resolved config values for this miner — non-secrets from state,
   *  secrets from the keychain, merged over the schema defaults. In-memory
   *  only; the descriptor maps these into how it runs (env vars, args). */
  config: Record<string, string | number | boolean>;
  /** Where this miner's commands run. Local shell today; a rented pod
   *  when the harness provisioned one. */
  machine: MinerMachine;
  /** Append a line to the miner's log (harness tees to file + stdout). */
  log(line: string): void;
}

export interface MinerStatus {
  running: boolean;
  detail?: string;
}

/**
 * One configurable field a subnet miner exposes. The harness renders a
 * form from these, stores the values per-miner (secrets in the OS
 * keychain, everything else in state), and hands the resolved values to
 * the descriptor as MinerContext.config at launch.
 */
export interface ConfigField {
  key: string;                                  // unique per descriptor
  label: string;
  type: "string" | "number" | "boolean" | "select" | "secret";
  default?: string | number | boolean;
  options?: string[];                           // for type "select"
  required?: boolean;
  help?: string;
}

export interface SubnetMiner {
  netuid: number;
  /** Short human name shown in the GUI row ("bazaar"). */
  name: string;
  requirements?: {
    gpu?: string;
    ramGb?: number;
    diskGb?: number;
    alwaysOn?: boolean;
    /** Validators must reach this miner from the internet — a NAT'd laptop can't serve it. */
    publicEndpoint?: boolean;
  };
  config?: ConfigField[];
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
