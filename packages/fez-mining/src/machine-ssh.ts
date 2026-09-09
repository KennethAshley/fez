import { execFile } from "node:child_process";
import type { MinerMachine, MachinePort } from "@fezchat/extension-api";
import { buildRemoteCommand } from "./machine-lium.js";

/**
 * The SSH machine seam (spec §7): any user-owned host — a doctl droplet,
 * the other laptop, a storage server — behind the same MinerMachine
 * interface. No provisioning step: the host already exists, so there is
 * no up/describe/teardown half, only exec/copy over the system `ssh` and
 * `scp` binaries. BatchMode everywhere: a password prompt inside a
 * harness is a hang, not a question — key auth or failure.
 *
 * The command discipline (guarded cd, export statements, single-quote
 * escaping, loader-env refusal) is machine-lium's buildRemoteCommand —
 * one discipline, two transports.
 */

export interface SshSpec {
  host: string;
  user: string;
  port?: number;
  /** Identity file; absent = whatever ssh-agent / default keys resolve. */
  keyPath?: string;
  /** Declared endpoint mappings — an owned host's ports are facts the
   *  owner states, not something to discover. */
  ports: MachinePort[];
}

/** Run a local process, argv-style (never a shell). Injectable for tests. */
export type SshRun = (argv: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRun: SshRun = (argv, timeoutMs) =>
  new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({
        code: err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      })
    );
  });

/**
 * "user@host", "user@host:port", or bare "host" (user defaults to root —
 * the droplet default). Validated hard: a target is a hostname, never a
 * place to smuggle an ssh option (`-oProxyCommand=...`) or a second argv
 * token — everything must match, or the whole string is refused.
 */
export function parseSshTarget(target: string): { user: string; host: string; port?: number } {
  const m = /^(?:([a-z_][a-z0-9_-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/.exec(target.trim());
  if (!m) throw new Error(`not a user@host[:port] target: ${JSON.stringify(target)}`);
  const port = m[3] ? Number(m[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error(`port out of range: ${port}`);
  return { user: m[1] ?? "root", host: m[2], ...(port !== undefined ? { port } : {}) };
}

/** Wrap an owned host as a MinerMachine. */
export function sshMachine(spec: SshSpec, run: SshRun = defaultRun): MinerMachine {
  const dest = `${spec.user}@${spec.host}`;
  // -p for ssh, -P for scp — same value, different flag, a classic. `--`
  // is NOT used: the destination is validated by parseSshTarget shape at
  // config time and these specs come from the harness's own state.
  const common = (portFlag: string): string[] => [
    "-o",
    "BatchMode=yes",
    // TOFU: a fez-provisioned droplet is ALWAYS an unknown host on first
    // contact, and BatchMode turns the interactive host-key prompt into a
    // hard failure — the DO live smoke burned 300s of ssh polls on exactly
    // that before this flag existed. accept-new trusts an unknown host
    // once and still refuses a CHANGED key, which is the attack that
    // matters.
    "-o",
    "StrictHostKeyChecking=accept-new",
    ...(spec.port !== undefined ? [portFlag, String(spec.port)] : []),
    ...(spec.keyPath ? ["-i", spec.keyPath] : []),
  ];
  return {
    kind: "ssh",
    ports: spec.ports,
    async exec(cmd, opts = {}) {
      const full = buildRemoteCommand(cmd, opts);
      const r = await run(["ssh", ...common("-p"), dest, full], opts.timeoutMs);
      // ssh reserves 255 for its OWN failures (connection refused, auth,
      // timeout) — the remote command can't produce it through ssh, so it
      // is the transport saying "I never ran your command". Callers
      // polling liveness must retry, never read it as the miner dying.
      if (r.code === 255) return { code: 255, stdout: r.stdout, stderr: r.stderr, transportError: true };
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    },
    async copy(localPath, remotePath) {
      const r = await run(["scp", ...common("-P"), "-r", localPath, `${dest}:${remotePath}`], 300_000);
      if (r.code !== 0) throw new Error(r.stderr || `scp exited ${r.code}`);
    },
  };
}
