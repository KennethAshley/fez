#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MinerMachine } from "@fezchat/extension-api";
import { DEFAULT_MAX_USD_HOUR } from "@fezchat/lium/cli";
import { loadDescriptors } from "./descriptors.js";
import { describePod, escapeShellValue, liumMachine, podAlive, provisionPod, teardownPod } from "./machine-lium.js";
import type { LiumExec, Recorder } from "./machine-lium.js";
import { localMachine } from "./machine-local.js";
import type { MinerEntry, MinerMachineState } from "./state.js";
import { fezHome, readState, upsertMiner, writeState } from "./state.js";

// Same PATH-resolved-bin convention as cli.ts's WALLET_BIN — read per-call
// (not a frozen module-level const) so tests can point it at a fake bin
// after this module is already loaded.
const walletBin = (): string => process.env.FEZ_WALLET_BIN || "fez-wallet";

// Same per-call-env convention — lets tests collapse the 45s initial wait
// to ~nothing without touching the retry logic itself.
const firstContactRetryDelayMs = (): number => Number(process.env.FEZ_MINE_RETRY_DELAY_MS) || 20_000;
const firstContactInitialWaitMs = (): number => Number(process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS) || 45_000;
const firstContactMaxAttempts = (): number => Number(process.env.FEZ_MINE_RETRY_ATTEMPTS) || 12;

// Root cause, live A/B (round 8): a descriptor's `ctx.machine.copy(local,
// \`${ctx.workDir}/...\`)` failed because workDir was the MAC's own path
// (~/.fez/mining/<netuid>-<persona>) — nonexistent on the pod, so scp's
// parent dir was missing. ctx.workDir is now machine-side: on a lium pod,
// a fixed dir under /root (never derived from the Mac's home), created once
// on fresh provision (see resolveMachine). The runner's OWN bookkeeping
// (miner.log, the registered flag) stays on the Mac under a separate
// `localDir` — see runMiner.
const remoteWorkDir = (netuid: number, persona: string): string => `/root/fez-mining/${netuid}-${persona}`;

/**
 * Pinned live 2026-09-08: a freshly-provisioned pod's `up` can report
 * "ready" before sshd actually accepts connections — an exec failed
 * seconds after `up` returned, then an IDENTICAL one minutes later
 * succeeded. This is the FIRST-contact wait: 45s initially (fresh pods are
 * never ready instantly), then up to 12 attempts, 20s apart (~4.75 min
 * total budget), one log line per retry (or silent if the caller passed no
 * logger).
 *
 * I4: this used to also wrap deployHotkey's mkdir+scp, nested on top of
 * copy()'s own 3x inner retry — 12 outer × 3 inner = 36 scp attempts behind
 * a readiness gate that already proved the pod reachable. The readiness
 * gate below (resolveMachine's "pod readiness" call) is the ONE authoritative
 * first-contact wait now; once it passes, deployHotkey runs single-attempt,
 * leaning on copy()'s own bounded 3x retry (10s apart) for a mid-life
 * transient upload blip. retryFirstContact itself is unchanged — it's just
 * down to one caller (the readiness gate).
 */
async function retryFirstContact(label: string, attempt: () => Promise<void>, log: (line: string) => void): Promise<void> {
  const maxAttempts = firstContactMaxAttempts();
  const initialWait = firstContactInitialWaitMs();
  const retryDelay = firstContactRetryDelayMs();

  // Wait before first attempt — fresh pods need time to boot sshd.
  await new Promise((r) => setTimeout(r, initialWait));

  for (let n = 1; n <= maxAttempts; n++) {
    try {
      await attempt();
      return;
    } catch (e) {
      if (n === maxAttempts) throw e;
      log(
        `${label} failed (attempt ${n}/${maxAttempts}): ${(e as Error).message} — retrying in ${retryDelay / 1000}s (fresh pod, sshd may not be up yet)`
      );
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
}

/**
 * Deploy the persona's standalone remote-signing key onto a freshly
 * provisioned pod — called ONLY right after `provisionPod`, never on a
 * reattach (the key is already there from the first deploy). The keyfile
 * touches disk just long enough to be copied: written 0600, deleted in
 * `finally`, never logged.
 *
 * I4: this runs AFTER resolveMachine's readiness gate already proved the
 * pod reachable (retryFirstContact("pod readiness", ...) below), so first
 * contact is proven — mkdir is a single attempt, and the copy leans on
 * copy()'s own bounded 3x inner retry (mid-life transient upload blips)
 * instead of an outer wrap nested on top of it.
 */
async function deployHotkey(persona: string, machine: MinerMachine): Promise<void> {
  const exported = JSON.parse(
    execFileSync(walletBin(), ["export-hotkey", persona, "--json"], { encoding: "utf8" })
  ) as { keyfile: unknown };
  const tmpFile = path.join(os.tmpdir(), `fez-hotkey-${crypto.randomUUID()}.json`);
  // lium scp does not expand ~ — pinned live 2026-09-08
  const hotkeyDir = "/root/.bittensor/wallets/default/hotkeys";
  try {
    await fs.writeFile(tmpFile, JSON.stringify(exported.keyfile), { mode: 0o600 });
    const r = await machine.exec(`mkdir -p ${escapeShellValue(hotkeyDir)}`);
    if (r.code !== 0) throw new Error(r.stderr || `mkdir exited ${r.code}`);
    await machine.copy(tmpFile, `${hotkeyDir}/${persona}`);
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}

/**
 * Where this miner's commands run. `opts.machineFactory` short-circuits
 * everything below it for tests — no real pod, no `lium` binary touched.
 * Otherwise: an entry with no `machine` (or `kind !== "lium"`) is the v1
 * local path, byte-identical to before this task. A `lium` entry reattaches
 * to its recorded pod if `podAlive`, re-`describe`ing it for the REAL port
 * map (lium's external↔internal mapping isn't derivable from what state.ts
 * persisted, so it is never fabricated from stored fields). If `describe`
 * itself fails — a pod `ps` still lists but is otherwise unreachable — that
 * pod is treated as gone, falling through to a fresh `provisionPod` (which
 * also deploys the hotkey, done only on that fresh-provision branch).
 *
 * `exec` is exposed (default: machine-lium's own `lium` binary call) so
 * this resolution logic itself — reattach vs. fresh-provision — is
 * unit-testable without `machineFactory` bypassing it entirely.
 */
export async function resolveMachine(
  entry: MinerEntry | undefined,
  persona: string,
  opts: { machineFactory?: (entry: MinerEntry) => Promise<MinerMachine> },
  exec?: LiumExec,
  recorder?: Recorder,
  log: (line: string) => void = () => {},
  persistProvision?: (machineState: MinerMachineState) => Promise<void>
): Promise<{ machine: MinerMachine; machineState?: MinerMachineState; provisioned?: boolean }> {
  if (opts.machineFactory) {
    if (!entry) throw new Error("machineFactory requires a recorded miner entry");
    return { machine: await opts.machineFactory(entry) };
  }
  if (entry?.machine?.kind === "lium") {
    const podId = entry.machine.podId;
    if (podId && (await podAlive(podId, exec))) {
      try {
        const handle = await describePod(podId, exec);
        return { machine: liumMachine(handle, exec) };
      } catch {
        // describe failed on a pod `ps` said was there (half-dead) —
        // best-effort teardown of the stale rental (never blocks the fresh
        // provision below on a `lium rm` hiccup) then fall through, rather
        // than run with fabricated ports. podId here is the entry's own
        // recorded pod id — an actual pod, never a pre-rent node id.
        await teardownPod(podId, exec, recorder).catch(() => {});
      }
    }
    const handle = await provisionPod(
      {
        ports: 2,
        maxUsdHour: Number(process.env.FEZ_LIUM_MAX_USD_HOUR) || DEFAULT_MAX_USD_HOUR,
        // 24h so an alwaysOn remote miner burns ~1 of the 3/day reprovision
        // budget on TTL expiry alone (sustainable steady-state) — a renew
        // loop that extends the lease before it expires is deliberately
        // YAGNI (ponytail: add one if 24h reprovisions prove disruptive).
        // Note: fez-lium's own DEFAULT_MAX_TTL_HOURS (4h) does NOT apply
        // here — that cap lives in guards.ts's checkUp(), which only gates
        // fez-lium's own `lium_up` MCP tool; this call goes straight at
        // the CLI via provisionPod and was never routed through checkUp.
        ttl: process.env.FEZ_MINE_POD_TTL || "24h",
      },
      exec,
      recorder
    );
    const machineState: MinerMachineState = {
      kind: "lium",
      podId: handle.podId,
      hourlyRate: handle.hourlyRate,
      externalIp: handle.ports[0]?.externalIp,
      externalPort: handle.ports[0]?.externalPort,
    };
    // Persist BEFORE deployHotkey — a pod that fails deploy/install/start
    // right after this must still be findable (billing, reattach,
    // sentinel, `fez-mine stop`), not silently orphaned. Live smoke: a
    // hotkey-deploy failure here once left a pod nobody's state pointed
    // to, found and torn down by hand.
    if (persistProvision) await persistProvision(machineState);
    const machine = liumMachine(handle, exec);
    // A fresh pod's `up` can report ready well before sshd actually
    // accepts a session — pinned live 2026-09-08. Probe with a no-op exec
    // before trusting the pod with anything: this IS the one authoritative
    // first-contact wait (I4) — everything after it (workDir mkdir,
    // deployHotkey) runs single-attempt.
    await retryFirstContact(
      "pod readiness",
      async () => {
        const r = await machine.exec("true");
        if (r.code !== 0) throw new Error(r.stderr || `exec exited ${r.code}`);
      },
      log
    );
    // ctx.workDir on this pod — created once here, right after readiness is
    // confirmed. A failure here is a provision failure exactly like a
    // deployHotkey failure (persistProvision already ran above, so
    // runMiner's catch block tears the pod down and clears the entry — see
    // freshMachineState there). A reattach to this SAME pod later skips
    // this: the dir is already on disk from this fresh provision.
    const workDirMk = await machine.exec(`mkdir -p ${escapeShellValue(remoteWorkDir(entry.netuid, persona))}`);
    if (workDirMk.code !== 0) throw new Error(workDirMk.stderr || `mkdir workDir exited ${workDirMk.code}`);
    await deployHotkey(persona, machine);
    return { machine, provisioned: true, machineState };
  }
  return { machine: localMachine() };
}

export async function runMiner(
  netuid: number,
  persona: string,
  home = fezHome(),
  opts: {
    hotkey?: string;
    machineFactory?: (entry: MinerEntry) => Promise<MinerMachine>;
    exec?: LiumExec;
    recorder?: Recorder;
  } = {}
): Promise<number> {
  const d = (await loadDescriptors(home)).find((m) => m.netuid === netuid);
  if (!d) throw new Error(`no miner descriptor for netuid ${netuid} — is the subnet's extension installed?`);
  // The hotkey was recorded into state by `fez-mine start` (from
  // RegisterResult.hotkey); the runner never talks to fez-wallet itself,
  // so a sentinel respawn needs no keychain access.
  const known = (await readState(home)).miners.find((m) => m.netuid === netuid && m.persona === persona);
  const hotkey = opts.hotkey ?? known?.hotkey;
  if (!hotkey) throw new Error(`no recorded hotkey for ${netuid}:${persona} — start it once with: fez-mine start`);
  // The runner's OWN bookkeeping (miner.log, the registered flag below) —
  // always on the Mac, regardless of where the miner itself runs. Distinct
  // from ctx.workDir (below), which is machine-side and may be a path on a
  // rented pod that doesn't exist on this filesystem at all.
  const localDir = path.join(home, "mining", `${netuid}-${persona}`);
  await fs.mkdir(localDir, { recursive: true });
  const logFile = path.join(localDir, "miner.log");
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    fs.appendFile(logFile, stamped).catch(() => {});
    process.stdout.write(stamped);
  };
  const record = async (patch: Partial<MinerEntry> & { bumpProvisions?: boolean }) => {
    const s = await readState(home);
    const cur = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
    const { bumpProvisions, ...fields } = patch;
    const provisions = bumpProvisions ? [...(cur?.provisions ?? []), Date.now()] : undefined;
    await writeState(
      home,
      upsertMiner(s, { netuid, persona, hotkey, desired: "running", ...cur, ...fields, ...(provisions ? { provisions } : {}) })
    );
  };

  // resolveMachine (a real `lium up`/`describe`/`rm` round-trip on the
  // remote path) is inside this same try — a provision failure used to
  // throw before any of this ran, dying silently: no `miner error:` line
  // in miner.log, no lastExit in state, visible only on the detached
  // process's own stdout (which nothing reads). Now it gets the same
  // logging + lastExit as an install/register/start failure.
  let code = 0;
  // Set only when THIS run fresh-provisioned a pod (persistProvision below)
  // — the signal the catch block uses to know there's something to tear
  // down. A reattach or local run leaves this undefined, so a LATER
  // install/start failure there never touches a pod this run didn't rent.
  let freshMachineState: MinerMachineState | undefined;
  try {
    const { machine, machineState, provisioned } = await resolveMachine(
      known,
      persona,
      opts,
      opts.exec,
      opts.recorder,
      log,
      async (ms) => {
        freshMachineState = ms;
        // Counts against the 3/day cap the same way headless's
        // reprovision does (I8) — at decision time, not at eventual
        // outcome, so a runner-side reprovision loop is never invisible
        // to planRemote's spend guard even if this run goes on to fail.
        await record({ pid: process.pid, startedAt: Date.now(), machine: ms, bumpProvisions: true });
      }
    );
    if (provisioned && machineState) {
      log(`provisioned pod ${machineState.podId} at $${machineState.hourlyRate ?? "?"}/hr (ttl ${process.env.FEZ_MINE_POD_TTL || "24h"})`);
    }
    // Local machines keep v1's full-environment forward. A REMOTE (lium)
    // pod gets ONLY what FEZ_MINE_FORWARD_ENV (comma-separated names,
    // default empty) names out of this process's own env — the Mac's
    // PATH/HOME/etc. have no business on a rented pod; a miner that needs
    // a secret there is configured through this allowlist deliberately,
    // not by accident.
    const env: Record<string, string> =
      machine.kind === "lium"
        ? Object.fromEntries(
            (process.env.FEZ_MINE_FORWARD_ENV ?? "")
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean)
              .filter((k) => process.env[k] !== undefined)
              .map((k) => [k, process.env[k] as string])
          )
        : ({ ...process.env } as Record<string, string>);
    // A local machine keeps v1's identical workDir (the same dir as
    // localDir). A lium machine gets a fixed path on ITS OWN filesystem —
    // never the Mac's home dir, which doesn't exist on the pod (root cause
    // of round 8's copy failure). See remoteWorkDir's doc comment.
    const workDir = machine.kind === "lium" ? remoteWorkDir(netuid, persona) : localDir;
    const ctx = { workDir, persona, hotkey, netuid, env, machine, log };

    // Reattach/local already got their pid/startedAt/machine recorded —
    // a fresh provision recorded its own above, before deployHotkey ran
    // (see the persistProvision callback), so it isn't repeated here.
    if (!provisioned) {
      await record({ pid: process.pid, startedAt: Date.now(), ...(machineState ? { machine: machineState } : {}) });
    }

    if (d.install) await d.install(ctx);
    // The registered flag is host-side bookkeeping (localDir), not
    // ctx.workDir — it tracks whether THIS runner has already driven
    // register() once, independent of whatever machine mined that time.
    const flag = path.join(localDir, "registered");
    if (d.register && !(await fs.access(flag).then(() => true, () => false))) {
      await d.register(ctx);
      await fs.writeFile(flag, "1");
    }
    await d.start(ctx);
  } catch (e) {
    log(`miner error: ${(e as Error).message}`);
    code = 1;
    if (freshMachineState?.podId) {
      // This run rented the pod and then failed before mining anything —
      // whether the failure was the deploy itself or install/register/
      // start afterward. A pod that never mines must never keep billing:
      // best-effort teardown, then clear the entry back to "no pod yet"
      // so the next start/reprovision rents fresh instead of reattaching
      // to a half-configured pod.
      await teardownPod(freshMachineState.podId, opts.exec, opts.recorder).catch(() => {});
      await record({ machine: { kind: "lium" } });
    }
  }
  await record({ pid: undefined, lastExit: `exit ${code} at ${new Date().toISOString()}` });
  return code;
}

// bin entry — run only when INVOKED, not when imported. installBins copies
// dist/run.js to a canonical file renamed to the bin key (bin/fez-mine-run,
// no extension) and symlinks it into ~/.fez/bin, so argv[1] never ends in
// "run.js" in production; a naive endsWith("run.js") check is dead code
// there. realpath BOTH sides — under the symlink, import.meta.url is the
// real file while argv[1] is the link (same fix as fez-git/credential.ts,
// review finding F9).
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
const invoked = (() => {
  try {
    return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
  } catch {
    return process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
  }
})();
if (invoked && import.meta.url === invoked) {
  const [netuid, persona] = process.argv.slice(2);
  if (!netuid || !persona) { console.error("usage: fez-mine-run <netuid> <persona>"); process.exit(2); }
  runMiner(Number(netuid), persona).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
