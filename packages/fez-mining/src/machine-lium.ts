import type { MinerMachine, MachinePort } from "@fezchat/extension-api";
import { lium, parseJson, DEFAULT_TTL } from "@fezchat/lium/cli";

/**
 * The Lium machine seam: a rented GPU pod behind the same MinerMachine
 * interface localMachine() offers. `exec` is injectable everywhere so unit
 * tests never touch the `lium` binary — only Task 12 (integration) does.
 *
 * Real shapes below were pinned read-only against the installed `lium`
 * 0.0.33 CLI (`--help` on every verb, plus `describe --json`'s error
 * envelope) and against fez-lium's own mcp.ts, which already drives this
 * exact CLI in production. `up`, `ps`'s success shape, and `describe`'s
 * success shape were NOT observable read-only (no API key configured on
 * this machine) — those parsers are marked "unverified" and coded
 * defensively; Task 12 confirms them live.
 */

export interface LiumHandle {
  podId: string;
  hourlyRate?: string;
  ports: MachinePort[];
  sshHost?: string;
}

export type LiumExec = (args: string[], timeoutMs?: number) => Promise<{ ok: true; out: string } | { ok: false; err: string }>;

/** A pod HUID looks like "eager-wolf-aa" / "cosmic-hawk-f2" (word-word-alnum2), per `lium up --help`'s examples. */
const HUID_RE = /\b[a-z]+-[a-z]+-[a-z0-9]{2}\b/;

/** Wrap an already-provisioned pod as a MinerMachine. */
export function liumMachine(handle: LiumHandle, exec: LiumExec = lium): MinerMachine {
  return {
    kind: "lium",
    ports: handle.ports,
    async exec(cmd, opts = {}) {
      // Pinned: `lium exec --help` — bare `--json` (not `--format json`),
      // `-e KEY=VALUE` (repeatable) for env, no cwd flag (so `cd` it).
      const args = ["exec", handle.podId];
      for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
      args.push(opts.cwd ? `cd ${opts.cwd} && ${cmd}` : cmd, "--json");
      const r = await exec(args, opts.timeoutMs);
      if (!r.ok) return { code: 1, stdout: "", stderr: r.err };
      // Pinned via fez-lium's mcp.ts lium_exec: the CLI always wraps in
      // `results` even for a single pod target: {results:[{pod,exit_code,stdout,stderr,error}]}.
      const j = parseJson<{ results?: { exit_code?: number; stdout?: string; stderr?: string }[] }>(r.out)?.results?.[0];
      return { code: j?.exit_code ?? 0, stdout: j?.stdout ?? r.out, stderr: j?.stderr ?? "" };
    },
    async copy(localPath, remotePath) {
      // Pinned: `lium scp --help` — TARGETS(pod) SOURCE [DESTINATION], no
      // "pod:path" colon syntax. Matches mcp.ts's lium_copy exactly.
      const r = await exec(["scp", handle.podId, localPath, remotePath], 300_000);
      if (!r.ok) throw new Error(r.err);
    },
  };
}

/** Pull a pod id + $/hr out of `up`'s output, JSON or plain text (see note below). */
function parseUpOutput(out: string): { podId: string | null; priceUsdHour: number | null } {
  // Unverified against live CLI: `lium up --help` exposes no --json/--format
  // flag at all (unlike every other verb here), so a real run's stdout is
  // plain human text by default. Tolerate a hypothetical JSON envelope
  // first (in case a future/local build emits one), else scrape the HUID
  // and a "$X.XX" price out of the text. Task 12 confirms the real shape.
  const j = parseJson<Record<string, unknown>>(out);
  if (j) {
    const podId = String(j.pod ?? j.pod_id ?? j.id ?? j.name ?? "") || null;
    const price = Number(j.price_per_hour ?? j.price ?? j.hourly_rate);
    return { podId, priceUsdHour: Number.isFinite(price) ? price : null };
  }
  const podId = HUID_RE.exec(out)?.[0] ?? null;
  const price = /\$(\d+(?:\.\d+)?)/.exec(out);
  return { podId, priceUsdHour: price ? Number(price[1]) : null };
}

/** Pull host/ports out of `describe --json`. */
function parseDescribe(out: string): { sshHost?: string; ports: MachinePort[] } {
  // Unverified against live CLI for the SUCCESS shape — only the error
  // envelope {ok:false,error:{...}} was observed read-only (no pod to
  // describe without an API key). Tolerates a {ok:true,pod:{...}} wrapper
  // or bare fields, and both external/internal and
  // external_port/internal_port port-item key names. Task 12 confirms.
  const raw = parseJson<Record<string, unknown>>(out) ?? {};
  const body = (raw.pod && typeof raw.pod === "object" ? raw.pod : raw) as Record<string, unknown>;
  const sshHost = (body.host_ip ?? body.ip ?? body.ssh_host) as string | undefined;
  const rows = Array.isArray(body.ports) ? (body.ports as Record<string, unknown>[]) : [];
  const ports: MachinePort[] = rows.map((p) => ({
    externalIp: sshHost ?? "",
    externalPort: Number(p.external ?? p.external_port),
    internalPort: Number(p.internal ?? p.internal_port),
  }));
  return { sshHost, ports };
}

/** `lium up` (auto-selected node via filters) then `lium describe` for the port map. */
export async function provisionPod(
  opts: { template?: string; ports?: number; ttl?: string; maxUsdHour?: number },
  exec: LiumExec = lium
): Promise<LiumHandle> {
  const ttl = opts.ttl || DEFAULT_TTL;
  // Pinned: `lium up --help` — no NODE_ID means auto-select via filters
  // (--ports is one). --yes skips the confirmation prompt; --no-ssh stops
  // `up` from opening an interactive SSH session (it does by default),
  // which would otherwise hang this process — mirrors fez-lium's lium_up.
  const args = ["up", "--yes", "--no-ssh", "--ttl", ttl];
  if (opts.ports) args.push("--ports", String(opts.ports));
  if (opts.template) args.push("--template_id", opts.template);
  const r = await exec(args, 120_000);
  if (!r.ok) throw new Error(r.err);

  const { podId, priceUsdHour } = parseUpOutput(r.out);
  if (!podId) throw new Error(`provisionPod: couldn't find a pod id in \`lium up\` output: ${r.out.slice(0, 400)}`);

  // Fail closed on money, same spirit as fez-lium's checkUp: an unreadable
  // price under a ceiling is treated as over it, not waved through.
  if (opts.maxUsdHour !== undefined && (priceUsdHour === null || priceUsdHour > opts.maxUsdHour)) {
    await teardownPod(podId, exec);
    throw new Error(
      priceUsdHour === null
        ? `provisionPod: refused — couldn't read ${podId}'s hourly price, not renting blind.`
        : `provisionPod: refused — $${priceUsdHour}/h exceeds the $${opts.maxUsdHour}/h ceiling.`
    );
  }

  const d = await exec(["describe", podId, "--json"], 30_000);
  const { sshHost, ports } = d.ok ? parseDescribe(d.out) : { sshHost: undefined, ports: [] };
  return { podId, hourlyRate: priceUsdHour !== null ? String(priceUsdHour) : undefined, ports, sshHost };
}

/** Is this pod still in `lium ps`? */
export async function podAlive(podId: string, exec: LiumExec = lium): Promise<boolean> {
  const r = await exec(["ps", "--format", "json"], 30_000);
  if (!r.ok) return false;
  const rows = parseJson<Record<string, unknown>[]>(r.out) ?? [];
  // Unverified against live CLI (auth-gated): tolerate pod/id/name/huid,
  // mirroring cli-lib's matchesNode tolerance for `ls` node rows.
  return rows.some((row) => ["pod", "id", "name", "huid"].some((k) => String(row[k] ?? "") === podId));
}

/** `lium rm <pod> --yes` — stop billing, disk dies with it. */
export async function teardownPod(podId: string, exec: LiumExec = lium): Promise<void> {
  const r = await exec(["rm", podId, "--yes"], 120_000);
  if (!r.ok) throw new Error(r.err);
}
