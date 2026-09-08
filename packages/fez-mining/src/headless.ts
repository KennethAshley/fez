import type { FezExtensionAPI } from "@fezchat/extension-api/headless";
import { readState, writeState, upsertMiner, fezHome } from "./state.js";
import { alive, spawnDetached } from "./procs.js";
import { planRemote } from "./reconcile.js";
import { podAlive } from "./machine-lium.js";

/**
 * fez-mining, headless part — the sentinel-side reconcile loop.
 *
 * Every 120s: read desired state, resolve pod-liveness (a real `lium ps`
 * call, serialized, up to 30s) only for distinct lium podIds belonging to
 * miners whose runner is already dead — planRemote's pod branch can't act
 * on a healthy miner anyway, so a healthy fleet costs zero pod calls — then
 * hand both to the pure planRemote (reconcile.ts): respawn a dead runner
 * onto a still-live pod, reprovision when the pod's gone, or (past the
 * daily reprovision cap) flag the miner for a human instead of looping
 * money away.
 *
 * Each miner is isolated: a failed action is logged and skipped rather
 * than aborting the tick, and state is persisted right after each action
 * (not once at the end) — so one miner's crash never loses another's
 * freshly-spawned pid and causes a double-spawn next tick.
 */
export default function activate(api: FezExtensionAPI): void {
  api.registerScheduledTask("mining-reconcile", 120_000, async () => {
    const home = fezHome();
    let s = await readState(home);

    const podIds = [
      ...new Set(
        s.miners
          .filter((m) => !alive(m.pid))
          .map((m) => (m.machine?.kind === "lium" ? m.machine.podId : undefined))
          .filter((id): id is string => !!id)
      ),
    ];
    const podAliveMap = new Map<string, boolean>();
    for (const id of podIds) podAliveMap.set(id, await podAlive(id));
    const podIsAlive = (podId: string) => podAliveMap.get(podId) ?? false;

    const now = Date.now();
    for (const { miner: m, action } of planRemote(s.miners, alive, podIsAlive, now)) {
      try {
        if (action === "needs-attention") {
          s = upsertMiner(s, m); // m already carries the attention text planRemote set
          await writeState(home, s);
          console.error(`mining-reconcile: ${m.netuid}:${m.persona} — ${m.attention}`);
          continue;
        }
        let entry = m;
        if (action === "reprovision" && entry.machine) {
          // Clear the dead pod (and its now-stale port info) and count the
          // reprovision against the daily cap; the runner provisions a
          // fresh pod on respawn (Task 7).
          entry = {
            ...entry,
            machine: { ...entry.machine, podId: undefined, externalIp: undefined, externalPort: undefined },
            provisions: [...(entry.provisions ?? []), now],
          };
        }
        const bin = process.env.FEZ_MINE_RUN_BIN || "fez-mine-run";
        const pid = spawnDetached(bin, [String(entry.netuid), entry.persona]);
        s = upsertMiner(s, { ...entry, pid, startedAt: Date.now() });
        await writeState(home, s);
      } catch (err) {
        console.error(`mining-reconcile: failed to ${action} ${m.netuid}:${m.persona}`, err);
      }
    }
  });
}
