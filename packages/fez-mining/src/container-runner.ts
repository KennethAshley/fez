import type { MinerContainer, MachinePort } from "@fezchat/extension-api";

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
