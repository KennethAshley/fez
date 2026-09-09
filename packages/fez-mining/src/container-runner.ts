import type { MinerContainer, MachinePort, MinerMachine } from "@fezchat/extension-api";
import { escapeShellValue } from "./machine-lium.js";

/**
 * Container miners (spec 2026-09-09): pure builders here, orchestration
 * below. Deterministic names are the point — `stop` must be able to
 * find the remote container with no shared state beyond netuid+persona.
 */
export function containerName(netuid: number, persona: string): string {
  return `fez-${netuid}-${persona}`;
}

/** "{key}" templates resolve from ctx.config; anything else is literal. */
export function resolveEnv(
  tpl: Record<string, string> | undefined,
  config: Record<string, string | number | boolean>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl ?? {})) {
    out[k] = v.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => String(config[key] ?? ""));
  }
  return out;
}

export function envFileContent(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join("");
}

const keyMount = (c: MinerContainer): string[] =>
  c.mountKeys ? ["-v", "/root/.bittensor:/root/.bittensor:ro"] : [];

export function dockerRunArgs(
  c: MinerContainer,
  name: string,
  envFilePath: string,
  machinePorts: MachinePort[]
): string[] {
  const publishes = (c.ports ?? []).flatMap((p) => {
    const m = machinePorts.find((mp) => mp.internalPort === p.internal);
    return ["-p", `${m?.externalPort ?? p.internal}:${p.internal}`];
  });
  return [
    "run", "-d", "--name", name, "--restart", "unless-stopped",
    "--env-file", envFilePath,
    ...publishes,
    ...keyMount(c),
    c.image,
  ];
}

export function dockerRegisterArgs(c: MinerContainer, envFilePath: string): string[] {
  return ["run", "--rm", "--env-file", envFilePath, ...keyMount(c), c.image, ...(c.register?.command ?? [])];
}

// Arg-array tokens are already split on flag boundaries — quoting every one
// (`docker 'run' '-d'`) breaks the exec strings the tests assert on. Only
// quote a token that actually needs it (spaces, `{`, etc.); plain
// flags/paths/image refs pass through bare.
const quoteArg = (a: string): string =>
  /^[A-Za-z0-9._\/@:=+-]+$/.test(a) ? a : escapeShellValue(a);

async function mustExec(
  machine: MinerMachine,
  cmd: string,
  what: string,
  opts: { timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await machine.exec(cmd, opts);
  if (r.transportError) throw new Error(`${what}: machine unreachable — ${r.stderr || "transport error"}`);
  return r;
}

/** Fail loudly with the fix; fez-provisioned machines never hit this. */
export async function ensureDocker(machine: MinerMachine, log: (l: string) => void): Promise<void> {
  const r = await mustExec(machine, "docker -v", "docker probe");
  if (r.code !== 0) {
    throw new Error(
      "this machine has no Docker — fez-provisioned machines get it automatically; on your own server: apt-get install -y docker.io"
    );
  }
  log(`docker: ${r.stdout.trim()}`);
}

export async function runContainerMiner(opts: {
  machine: MinerMachine;
  container: MinerContainer;
  netuid: number;
  persona: string;
  workDir: string;
  config: Record<string, string | number | boolean>;
  registered: boolean;
  log: (l: string) => void;
}): Promise<number> {
  const { machine, container: c, netuid, persona, workDir, config, registered, log } = opts;
  const name = containerName(netuid, persona);
  const envFile = `${workDir}/.env`;

  const pull = await mustExec(machine, `docker pull ${escapeShellValue(c.image)}`, "pull", { timeoutMs: 600_000 });
  if (pull.code !== 0) throw new Error(`docker pull failed: ${pull.stderr || pull.stdout}`);

  // Secrets ride an env-file (mode 600), never argv — ps-safe.
  const env = resolveEnv(c.env, config);
  const write = await mustExec(
    machine,
    `printf %s ${escapeShellValue(envFileContent(env))} > ${escapeShellValue(envFile)} && chmod 600 ${escapeShellValue(envFile)}`,
    "env-file"
  );
  if (write.code !== 0) throw new Error(`env-file write failed: ${write.stderr}`);

  if (c.compose) {
    const composeFile = `${workDir}/compose.yml`;
    const w = await mustExec(
      machine,
      `printf %s ${escapeShellValue(c.compose)} > ${escapeShellValue(composeFile)}`,
      "compose-file"
    );
    if (w.code !== 0) throw new Error(`compose-file write failed: ${w.stderr}`);
    const base = `docker compose -p ${escapeShellValue(name)} -f ${escapeShellValue(composeFile)} --env-file ${escapeShellValue(envFile)}`;
    const pullC = await mustExec(machine, `${base} pull`, "compose pull", { timeoutMs: 600_000 });
    if (pullC.code !== 0) throw new Error(`compose pull failed: ${pullC.stderr || pullC.stdout}`);
    const up = await mustExec(machine, `${base} up -d`, "compose up");
    if (up.code !== 0) throw new Error(`compose up exited ${up.code}: ${up.stderr || up.stdout}`);
    // Block until the project's containers all exit (mirrors docker wait).
    const waitedC = await mustExec(machine, `${base} wait 2>/dev/null || ${base} ps --quiet | xargs -r docker wait | tail -1`, "compose wait");
    const codeC = Number(waitedC.stdout.trim().split("\n").pop());
    return Number.isFinite(codeC) ? codeC : waitedC.code;
  }

  if (c.register && !registered) {
    log(`container: one-shot register (${c.register.command.join(" ")})`);
    const reg = await mustExec(
      machine,
      `docker ${dockerRegisterArgs(c, envFile).map(quoteArg).join(" ")}`,
      "register",
      { timeoutMs: 300_000 }
    );
    if (reg.code !== 0) throw new Error(`container register exited ${reg.code}: ${reg.stderr || reg.stdout}`);
  }

  // A stale same-name container (crashed runner, prior run) blocks -d.
  await mustExec(machine, `docker rm -f ${escapeShellValue(name)} 2>/dev/null || true`, "stale rm");

  log(`container: starting ${name} from ${c.image}`);
  const run = await mustExec(
    machine,
    `docker ${dockerRunArgs(c, name, envFile, machine.ports).map(quoteArg).join(" ")}`,
    "run"
  );
  if (run.code !== 0) throw new Error(`docker run exited ${run.code}: ${run.stderr || run.stdout}`);

  // Blocking wait — keeps the harness's "start resolves when mining
  // stops" contract, so supervision/reconcile need no changes. No
  // timeout: mining runs for days.
  const waited = await mustExec(machine, `docker wait ${escapeShellValue(name)}`, "wait");
  const code = Number(waited.stdout.trim());
  return Number.isFinite(code) ? code : waited.code;
}

export async function stopContainerMiner(machine: MinerMachine, netuid: number, persona: string): Promise<void> {
  // rm -f by deterministic name: reaches the remote process even when the
  // local runner is long dead — the orphan gap closed for containers.
  // The compose variant tears down its project the same call.
  const name = containerName(netuid, persona);
  await machine.exec(`docker rm -f ${escapeShellValue(name)}`).catch(() => undefined);
  await machine.exec(`docker compose -p ${escapeShellValue(name)} down 2>/dev/null || true`).catch(() => undefined);
}

/** Tail the container's own stdout — feeds `fez-mine logs` for container miners. */
export async function containerLogs(
  machine: MinerMachine,
  netuid: number,
  persona: string,
  lines: number
): Promise<string> {
  const r = await machine.exec(
    `docker logs --tail ${Math.max(1, Math.floor(lines))} ${escapeShellValue(containerName(netuid, persona))} 2>&1`
  );
  return r.stdout || r.stderr;
}
