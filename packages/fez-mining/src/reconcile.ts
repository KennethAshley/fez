import type { MinerEntry } from "./state.js";

const DAY = 86_400_000;

export type ReconcileAction = { miner: MinerEntry; action: "respawn-runner" | "reprovision" | "needs-attention" };

/**
 * Desired-running miners whose recorded pid is gone, mapped to what the
 * sentinel should do about it. Local miners (no `machine`) always just
 * respawn — the v1 rule. Lium miners get a pod check first: pod still up
 * means the process died but the rental didn't, so respawn the runner onto
 * it; pod gone — including a `podId` that never got recorded (start
 * recorded before the runner provisioned anything, or cleared on a prior
 * stop) — counts as pod-dead too, so it needs a fresh rental (reprovision),
 * UNLESS this miner has already reprovisioned `maxPerDay` times in the
 * last 24h — then it's a spend-guard trip: needs-attention instead of an
 * unbounded reprovision loop.
 */
export function planRemote(
  miners: MinerEntry[],
  isAlive: (pid?: number) => boolean,
  podIsAlive: (podId: string) => boolean,
  now: number,
  maxPerDay = 3
): ReconcileAction[] {
  const out: ReconcileAction[] = [];
  for (const m of miners) {
    if (m.mode === "submission" || m.desired !== "running" || isAlive(m.pid)) continue;
    if (m.machine?.kind !== "lium") {
      out.push({ miner: m, action: "respawn-runner" });
      continue;
    }
    if (m.machine.podId && podIsAlive(m.machine.podId)) {
      out.push({ miner: m, action: "respawn-runner" });
      continue;
    }
    const recent = (m.provisions ?? []).filter((t) => t > now - DAY);
    if (recent.length >= maxPerDay) {
      out.push({
        miner: { ...m, attention: `hit the daily reprovision cap (${maxPerDay}/24h) — check the pod manually` },
        action: "needs-attention",
      });
    } else {
      out.push({ miner: m, action: "reprovision" });
    }
  }
  return out;
}

/** Miners that should be respawned: desired running, but the recorded pid is gone. v1 shape, kept for compatibility. */
export function plan(miners: MinerEntry[], isAlive: (pid?: number) => boolean): MinerEntry[] {
  return planRemote(miners, isAlive, () => false, Date.now())
    .filter((a) => a.action === "respawn-runner")
    .map((a) => a.miner);
}
