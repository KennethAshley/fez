#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { loadDescriptors } from "./descriptors.js";
import { localMachine } from "./machine-local.js";
import { fezHome, readState, upsertMiner, writeState } from "./state.js";

export async function runMiner(
  netuid: number,
  persona: string,
  home = fezHome(),
  opts: { hotkey?: string } = {}
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
  const ctx = { workDir, persona, hotkey, netuid, env: { ...process.env } as Record<string, string>, machine: localMachine(), log };

  const record = async (patch: Partial<import("./state.js").MinerEntry>) => {
    const s = await readState(home);
    const cur = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
    await writeState(home, upsertMiner(s, { netuid, persona, hotkey, desired: "running", ...cur, ...patch }));
  };

  await record({ pid: process.pid, startedAt: Date.now() });
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
