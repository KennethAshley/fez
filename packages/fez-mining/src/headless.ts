import type { FezExtensionAPI } from "@fezchat/extension-api/headless";
import { readState, writeState, upsertMiner, updateState, minerKey, fezHome, type MinerEntry } from "./state.js";
import { alive, spawnDetached } from "./procs.js";
import { planRemote } from "./reconcile.js";
import { podAlive } from "./machine-lium.js";
import { lifecycleMessage } from "./lifecycle.js";
import { MINING_CHANNEL_NAME, MINING_SOURCE, minerRootLine } from "./thread.js";
import { postAsPersona, dmOwnerAsPersona } from "./persona-post.js";
import { attentionDmText, shouldDmAttention } from "./attention-dm.js";
import { submissionCommand } from "./submission.js";
import path from "node:path";
import { homedir } from "node:os";

/** Pure seam for testing: the thread-root backfill text for a miner. */
export function rootBackfillText(netuid: number, persona: string): string {
  return minerRootLine(netuid, persona);
}

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
 *
 * The plan itself (`planRemote`) is computed once, from the snapshot read
 * at the top of the tick — fine, since it only decides WHAT to do. But
 * applying that decision re-reads state fresh right before each write:
 * a `fez-mine stop` landing on this miner mid-tick (a `describe`/`ps`
 * round-trip is real network time) must not get overwritten back to
 * "running" by a decision made on stale state, so every action is
 * skipped once `desired !== "running"` on the fresh read.
 *
 * After the reconcile, the same tick posts each miner's news into its
 * GUI-opened thread — `channels` on `ctx` is what a scheduled task
 * actually gets handed (see fez-github's headless.ts for the same
 * pattern); `api.channels` is the coarser "does this host have a key
 * and a relay at all" signal, checked once as a cheap early-out.
 */
export default function activate(api: FezExtensionAPI): void {
  api.registerScheduledTask("mining-reconcile", 120_000, async (ctx) => {
    const home = fezHome();
    const s = await readState(home);

    for (const miner of s.miners.filter(m => m.mode === "submission")) {
      try {
        await submissionCommand("status",miner.netuid,miner.persona,{},home,
          process.env.FEZ_WALLET_BIN || path.join(homedir(),".fez/bin/fez-wallet"));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Refresh failed";
        if (message.includes("operation is in progress")) continue;
        // submissionCommand records the stale snapshot for every caller.
        console.error(`mining-reconcile: ${miner.netuid}:${miner.persona} — ${message}`);
      }
    }

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
        // Re-read fresh right before applying — a stop (or another tick's
        // write) may have landed since the plan was computed above.
        const fresh = await readState(home);
        const freshEntry = fresh.miners.find((e) => e.netuid === m.netuid && e.persona === m.persona);
        if (!freshEntry || freshEntry.desired !== "running") continue; // a stop landed meanwhile

        if (action === "needs-attention") {
          await writeState(home, upsertMiner(fresh, { ...freshEntry, attention: m.attention }));
          console.error(`mining-reconcile: ${m.netuid}:${m.persona} — ${m.attention}`);

          const dmKey = `dm-attention:${minerKey(m.netuid, m.persona)}`;
          const prevMarker = await api.storage.get<string>(dmKey);
          if (shouldDmAttention(prevMarker, m.attention ?? "")) {
            try {
              await dmOwnerAsPersona(
                m.persona,
                ctx.ownerPubkey,
                attentionDmText(m.netuid, m.persona, m.attention ?? "needs attention")
              );
              await api.storage.set(dmKey, m.attention ?? "");
            } catch (err) {
              console.error(`mining-reconcile: failed to DM owner for ${m.netuid}:${m.persona}`, err);
            }
          }
          continue;
        }
        let entry = freshEntry;
        // Reprovision only means anything for a machine the harness rents —
        // an ssh host is owned, there is nothing to re-rent.
        if (action === "reprovision" && entry.machine?.kind === "lium") {
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
        await writeState(home, upsertMiner(fresh, { ...entry, pid, startedAt: Date.now() }));
        // Recovered → clear the attention ping marker so a future problem pings again.
        await api.storage.set(`dm-attention:${minerKey(entry.netuid, entry.persona)}`, "");
      } catch (err) {
        console.error(`mining-reconcile: failed to ${action} ${m.netuid}:${m.persona}`, err);
      }
    }

    // Lifecycle replies — best-effort, and never the reconcile's problem.
    // Every RUNNING miner gets a thread: the GUI posts a root on start, but
    // if that post flaked (the relay hadn't absorbed it inside the GUI's
    // retry window) the miner would otherwise have no thread and no
    // history. So here we BACKFILL a root for any running miner missing
    // one — `say` returns the event id, which we record as threadRootId so
    // the GUI reuses it (its recordedRootId fast path) and we never double
    // post. A stopped miner with no thread stays threadless (its history
    // is nothing to show); the GUI-vs-headless race is bounded by the 120s
    // tick against the GUI's seconds-long set-root, so a duplicate root is
    // vanishingly rare and at worst a stray line.
    if (!api.channels) return; // no key/relay on this host at all
    try {
      const channelId = await ctx.channels.ensure({ name: MINING_CHANNEL_NAME, source: MINING_SOURCE });
      if (!channelId) return; // unclaimed relay, or we're not the owner — nothing to post into

      let final = await readState(home);
      for (const miner of final.miners) {
        if (!miner.threadRootId) {
          if (miner.mode !== "submission" && miner.desired !== "running") continue;
          try {
            const rootId = await postAsPersona(miner.persona, channelId, rootBackfillText(miner.netuid, miner.persona));
            await updateState(home,st => {
              const e = st.miners.find((x) => x.netuid === miner.netuid && x.persona === miner.persona);
              return e ? upsertMiner(st, { ...e, threadRootId: rootId }) : undefined;
            });
            miner.threadRootId = rootId; // use it for this tick's lifecycle reply too
            final = await readState(home);
          } catch (err) {
            console.error(`mining-reconcile: failed to backfill a root for ${miner.netuid}:${miner.persona}`, err);
            continue;
          }
        }
        const snapKey = `lifecycle:${minerKey(miner.netuid, miner.persona)}`;
        const prev = await api.storage.get<MinerEntry>(snapKey);
        const text = lifecycleMessage(prev, miner);
        if (text) {
          try {
            await postAsPersona(miner.persona, channelId, text, { threadRoot: miner.threadRootId });
          } catch (err) {
            console.error(`mining-reconcile: failed to post lifecycle reply for ${miner.netuid}:${miner.persona}`, err);
            continue; // don't advance the snapshot — retry this transition next tick
          }
        }
        await api.storage.set(snapKey, miner);
      }
    } catch (err) {
      console.error("mining-reconcile: lifecycle posting failed", err);
    }
  });
}
