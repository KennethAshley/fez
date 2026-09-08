import type { MinerMachine, MachinePort } from "@fezchat/extension-api";
import { lium, parseJson, priceOf, DEFAULT_TTL, record } from "@fezchat/lium/cli";

/**
 * The Lium machine seam: a rented GPU pod behind the same MinerMachine
 * interface localMachine() offers. `exec` is injectable everywhere so unit
 * tests never touch the `lium` binary — only Task 12 (integration) does.
 *
 * Real shapes below were pinned read-only against the installed `lium`
 * 0.0.33 CLI (`--help` on every verb, plus `describe --json`'s error
 * envelope) and against fez-lium's own mcp.ts, which already drives this
 * exact CLI in production. Task 12's live smoke since confirmed the two
 * that weren't observable read-only: `lium up` with no NODE_ID and no
 * filters refuses outright ("Must provide either NODE_ID or filters"), and
 * `ps --format json` (not `ps --json`) is the real flag. `describe`'s
 * success shape is still coded defensively pending a live pod to confirm it.
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

// Loader-affecting env names refused on every exec, regardless of who
// forwards them (run.ts's own curation is layer one; this is layer two) —
// same philosophy as the host's gui.ts spawn seam (see its doc comment on
// env refusal): names that change how the remote shell loads code, not
// what it does, have no business riding along to a rented pod.
const REFUSED_ENV_PREFIXES = ["LD_", "DYLD_"];
const REFUSED_ENV_NAMES = new Set(["PATH", "HOME", "NODE_OPTIONS"]);
function isRefusedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return REFUSED_ENV_NAMES.has(upper) || REFUSED_ENV_PREFIXES.some((p) => upper.startsWith(p));
}

/** Wrap an already-provisioned pod as a MinerMachine. */
export function liumMachine(handle: LiumHandle, exec: LiumExec = lium): MinerMachine {
  return {
    kind: "lium",
    ports: handle.ports,
    async exec(cmd, opts = {}) {
      // Pinned: `lium exec --help` — bare `--json` (not `--format json`),
      // `-e KEY=VALUE` (repeatable) for env, no cwd flag (so `cd` it).
      const args = ["exec", handle.podId];
      for (const [k, v] of Object.entries(opts.env ?? {})) {
        if (isRefusedEnvName(k)) continue;
        args.push("-e", `${k}=${v}`);
      }
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

/** A `lium ls` row's id, in the same key preference `matchesNode` checks against — huid first (what a human/agent would target it by). */
function nodeIdOf(row: Record<string, unknown>): string | null {
  for (const k of ["huid", "id", "index"]) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v) !== "") return String(v);
  }
  return null;
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

/**
 * `lium describe <pod> --json` alone — the real, current port map for an
 * ALREADY-provisioned pod. Used both by provisionPod (right after `up`)
 * and by a reattach (run.ts): lium's external↔internal port mapping isn't
 * derivable from state.ts's persisted externalIp/externalPort, so a
 * reattach must re-describe rather than fabricate. Throws on failure —
 * callers that mean "pod's gone, not just unreachable this second" (a
 * reattach) should catch and fall through to a fresh provision.
 */
export async function describePod(podId: string, exec: LiumExec = lium): Promise<LiumHandle> {
  const d = await exec(["describe", podId, "--json"], 30_000);
  if (!d.ok) throw new Error(d.err);
  const { sshHost, ports } = parseDescribe(d.out);
  return { podId, ports, sshHost };
}

/**
 * `lium ls` (pick the cheapest node at/under the ceiling ourselves — `up`
 * with no NODE_ID and no filters refuses outright, verified live) then
 * `lium up <node>` then `lium describe` for the port map.
 */
export async function provisionPod(
  opts: { template?: string; ports?: number; ttl?: string; maxUsdHour?: number },
  exec: LiumExec = lium
): Promise<LiumHandle> {
  const ttl = opts.ttl || DEFAULT_TTL;
  const ceiling = opts.maxUsdHour ?? Infinity;

  // Node selection IS the price ceiling now — pre-rent, not a post-hoc
  // refuse-and-teardown. `ls --format json` is the verified-live flag.
  const lsRes = await exec(["ls", "--format", "json"], 30_000);
  if (!lsRes.ok) throw new Error(lsRes.err);
  const rows = parseJson<Record<string, unknown>[]>(lsRes.out) ?? [];
  let best: { id: string; price: number } | null = null;
  let cheapestSeen: number | null = null;
  for (const row of rows) {
    const price = priceOf(row);
    const id = nodeIdOf(row);
    if (price === null || !id) continue;
    if (cheapestSeen === null || price < cheapestSeen) cheapestSeen = price;
    if (price <= ceiling && (best === null || price < best.price)) best = { id, price };
  }
  if (!best) {
    throw new Error(
      cheapestSeen === null
        ? "provisionPod: refused — `lium ls` returned no node with a readable price, not renting blind."
        : `provisionPod: refused — no node at or under the $${ceiling}/h ceiling (cheapest seen: $${cheapestSeen}/h).`
    );
  }

  // --yes skips the confirmation prompt; --no-ssh stops `up` from opening
  // an interactive SSH session (it does by default), which would otherwise
  // hang this process — mirrors fez-lium's lium_up.
  const args = ["up", best.id, "--yes", "--no-ssh", "--ttl", ttl];
  if (opts.ports) args.push("--ports", String(opts.ports));
  if (opts.template) args.push("--template_id", opts.template);
  const r = await exec(args, 120_000);
  if (!r.ok) throw new Error(r.err);

  const { podId, priceUsdHour } = parseUpOutput(r.out);
  if (!podId) throw new Error(`provisionPod: couldn't find a pod id in \`lium up\` output: ${r.out.slice(0, 400)}`);

  // Belt-and-suspenders against a race (the price could have moved between
  // `ls` and `up`) — same fail-closed spirit as fez-lium's checkUp.
  if (opts.maxUsdHour !== undefined && (priceUsdHour === null || priceUsdHour > opts.maxUsdHour)) {
    await teardownPod(podId, exec);
    throw new Error(
      priceUsdHour === null
        ? `provisionPod: refused — couldn't read ${podId}'s hourly price, not renting blind.`
        : `provisionPod: refused — $${priceUsdHour}/h exceeds the $${opts.maxUsdHour}/h ceiling.`
    );
  }

  // Honest ledger row for the rental — best-effort, never blocks (record()
  // swallows its own errors); a real row so "what did compute cost" has an
  // answer even for pods the runner rented without a human in the loop.
  await record({ action: "up", pod: podId, usdHour: priceUsdHour ?? undefined, ttl });

  const { sshHost, ports } = await describePod(podId, exec).catch(() => ({ sshHost: undefined, ports: [] as MachinePort[] }));
  return { podId, hourlyRate: priceUsdHour !== null ? String(priceUsdHour) : undefined, ports, sshHost };
}

/** Is this pod still in `lium ps`? */
export async function podAlive(podId: string, exec: LiumExec = lium): Promise<boolean> {
  // Pinned live (Task 12): `ps --format json` (not `ps --json`) → `[]` when
  // no pods are running.
  const r = await exec(["ps", "--format", "json"], 30_000);
  if (!r.ok) return false;
  const rows = parseJson<Record<string, unknown>[]>(r.out) ?? [];
  // Row-key tolerance (pod/id/name/huid) still unverified against a row
  // with an actual pod in it — mirrors cli-lib's matchesNode tolerance for
  // `ls` node rows.
  return rows.some((row) => ["pod", "id", "name", "huid"].some((k) => String(row[k] ?? "") === podId));
}

/** `lium rm <pod> --yes` — stop billing, disk dies with it. */
export async function teardownPod(podId: string, exec: LiumExec = lium): Promise<void> {
  const r = await exec(["rm", podId, "--yes"], 120_000);
  await record({ action: "rm", pod: podId, detail: r.ok ? undefined : r.err });
  if (!r.ok) throw new Error(r.err);
}
