import type { FezExtensionAPI } from "@fezchat/extension-api/headless";
import { readState, writeState, upsertMiner, fezHome } from "./state.js";
import { alive, spawnDetached } from "./procs.js";
import { plan } from "./reconcile.js";

/**
 * fez-mining, headless part — the sentinel-side reconcile loop.
 *
 * Every 120s: read desired state, respawn any miner marked "running"
 * whose recorded pid is no longer alive (crash, OOM, host reboot).
 * Pure planning lives in reconcile.ts; this just wires it to procs/state.
 *
 * Each miner is isolated: a failed spawn is logged and skipped rather
 * than aborting the tick, and state is persisted right after each
 * successful spawn (not once at the end) — so one miner's crash never
 * loses another's freshly-spawned pid and causes a double-spawn next
 * tick.
 */
export default function activate(api: FezExtensionAPI): void {
  api.registerScheduledTask("mining-reconcile", 120_000, async () => {
    const home = fezHome();
    let s = await readState(home);
    for (const m of plan(s.miners, alive)) {
      try {
        const bin = process.env.FEZ_MINE_RUN_BIN || "fez-mine-run";
        const pid = spawnDetached(bin, [String(m.netuid), m.persona]);
        s = upsertMiner(s, { ...m, pid, startedAt: Date.now() });
        await writeState(home, s);
      } catch (err) {
        console.error(`mining-reconcile: failed to respawn ${m.netuid}:${m.persona}`, err);
      }
    }
  });
}
