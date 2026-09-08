#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MinerMachine } from "@fezchat/extension-api";
import { loadDescriptors } from "./descriptors.js";
import { describePod, liumMachine, podAlive, provisionPod } from "./machine-lium.js";
import type { LiumExec } from "./machine-lium.js";
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
  exec?: LiumExec
): Promise<{ machine: MinerMachine; machineState?: MinerMachineState }> {
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
        // describe failed on a pod `ps` said was there (half-dead) — fall
        // through to provisioning a fresh one rather than run with
        // fabricated ports.
      }
    }
    const handle = await provisionPod({}, exec);
    const machine = liumMachine(handle, exec);
    await deployHotkey(persona, machine);
    return {
      machine,
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
  opts: { hotkey?: string; machineFactory?: (entry: MinerEntry) => Promise<MinerMachine> } = {}
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
  const { machine, machineState } = await resolveMachine(known, persona, opts);
  const ctx = { workDir, persona, hotkey, netuid, env: { ...process.env } as Record<string, string>, machine, log };

  const record = async (patch: Partial<MinerEntry>) => {
    const s = await readState(home);
    const cur = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
    await writeState(home, upsertMiner(s, { netuid, persona, hotkey, desired: "running", ...cur, ...patch }));
  };

  await record({ pid: process.pid, startedAt: Date.now(), ...(machineState ? { machine: machineState } : {}) });
  let code = 0;
  try {
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
