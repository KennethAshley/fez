#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MinerMachine } from "@fezchat/extension-api";
import { DEFAULT_MAX_USD_HOUR } from "@fezchat/lium/cli";
import { loadDescriptors } from "./descriptors.js";
import { describePod, liumMachine, podAlive, provisionPod, teardownPod } from "./machine-lium.js";
import type { LiumExec, Recorder } from "./machine-lium.js";
import { localMachine } from "./machine-local.js";
import type { MinerEntry, MinerMachineState } from "./state.js";
import { fezHome, readState, upsertMiner, writeState } from "./state.js";

// Same PATH-resolved-bin convention as cli.ts's WALLET_BIN — read per-call
// (not a frozen module-level const) so tests can point it at a fake bin
// after this module is already loaded.
const walletBin = (): string => process.env.FEZ_WALLET_BIN || "fez-wallet";

/**
 * Deploy the persona's standalone remote-signing key onto a freshly
 * provisioned pod — called ONLY right after `provisionPod`, never on a
 * reattach (the key is already there from the first deploy). The keyfile
 * touches disk just long enough to be copied: written 0600, deleted in
 * `finally`, never logged.
 */
async function deployHotkey(persona: string, machine: MinerMachine): Promise<void> {
  const exported = JSON.parse(
    execFileSync(walletBin(), ["export-hotkey", persona, "--json"], { encoding: "utf8" })
  ) as { keyfile: unknown };
  const tmpFile = path.join(os.tmpdir(), `fez-hotkey-${crypto.randomUUID()}.json`);
  try {
    await fs.writeFile(tmpFile, JSON.stringify(exported.keyfile), { mode: 0o600 });
    await machine.exec("mkdir -p ~/.bittensor/wallets/default/hotkeys");
    await machine.copy(tmpFile, `~/.bittensor/wallets/default/hotkeys/${persona}`);
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
  recorder?: Recorder
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
    const machine = liumMachine(handle, exec);
    await deployHotkey(persona, machine);
    return {
      machine,
      provisioned: true,
      machineState: {
        kind: "lium",
        podId: handle.podId,
        hourlyRate: handle.hourlyRate,
        externalIp: handle.ports[0]?.externalIp,
        externalPort: handle.ports[0]?.externalPort,
      },
    };
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
  const workDir = path.join(home, "mining", `${netuid}-${persona}`);
  await fs.mkdir(workDir, { recursive: true });
  const logFile = path.join(workDir, "miner.log");
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
  try {
    const { machine, machineState, provisioned } = await resolveMachine(known, persona, opts, opts.exec, opts.recorder);
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
    const ctx = { workDir, persona, hotkey, netuid, env, machine, log };

    // A fresh provision (first-ever or after a half-dead reattach fell
    // through) counts against the 3/day cap the same way headless's
    // reprovision does — otherwise a runner-side reprovision loop would be
    // invisible to planRemote's spend guard.
    await record({
      pid: process.pid,
      startedAt: Date.now(),
      ...(machineState ? { machine: machineState } : {}),
      bumpProvisions: !!provisioned,
    });

    if (d.install) await d.install(ctx);
    const flag = path.join(workDir, "registered");
    if (d.register && !(await fs.access(flag).then(() => true, () => false))) {
      await d.register(ctx);
      await fs.writeFile(flag, "1");
    }
    await d.start(ctx);
  } catch (e) {
    log(`miner error: ${(e as Error).message}`);
    code = 1;
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
