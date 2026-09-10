import fs from "node:fs/promises";
import * as nativeFs from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { lock } from "proper-lockfile";
import { readState, updateState, upsertMiner } from "./state.js";
import { minerRootLine } from "./thread.js";
import { findPersonaRoot, postAsPersona } from "./persona-post.js";

// Older releases left an empty file instead of a renewable directory lock.
// Age alone cannot prove that an old process has finished: check its open FD.
const threadLockFs = {
  ...nativeFs,
  rmdir(target: string, callback: nativeFs.NoParamCallback) {
    nativeFs.rmdir(target, error => {
      if (error?.code !== "ENOTDIR") return callback(error);
      execFile("lsof", ["-t", target], { timeout: 2_000 }, (error, stdout, stderr) => {
        if (error?.code === 1 && !stdout.trim() && !stderr.trim()) return nativeFs.unlink(target, callback);
        callback(Object.assign(Error("The previous miner thread operation still holds its lock, or its owner could not be checked"), { code: "ELOCKED" }));
      });
    });
  },
};

/** Shared by the GUI CLI and reconcile so one local miner has one root per relay/channel. */
export async function ensureMinerThread(
  home: string, netuid: number, persona: string, channelId: string,
  io = { find: findPersonaRoot, post: postAsPersona }, relay?: string,
): Promise<string> {
  if (!Number.isSafeInteger(netuid) || netuid < 0 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(persona)) throw Error("Invalid miner identity");
  if (relay && !/^wss?:\/\//.test(relay)) throw Error("Invalid workspace relay");
  if (!channelId || channelId.length > 256 || /\s/.test(channelId)) throw Error("Invalid channel ID");
  const dir = path.join(home,"mining",`${netuid}-${persona}`);
  await fs.mkdir(dir,{recursive:true});
  let compromised: Error | undefined;
  const release = await lock(dir, {
    lockfilePath: path.join(dir,"thread.lock"), fs: threadLockFs,
    stale: 10_000, update: 2_000,
    retries: { retries: 100, factor: 1, minTimeout: 150, maxTimeout: 150 },
    onCompromised: error => { compromised = error; },
  });
  try {
    const entry = (await readState(home)).miners.find(m => m.netuid === netuid && m.persona === persona);
    if (!entry) throw Error(`No recorded miner ${netuid}:${persona}`);
    if (entry.threadChannelId === channelId && entry.threadRelay === relay && entry.threadRootId) return entry.threadRootId;
    const scope = JSON.stringify([relay ?? null, channelId]);
    const threadRoots = { ...entry.threadRoots };
    if (entry.threadChannelId && entry.threadRootId) {
      threadRoots[JSON.stringify([entry.threadRelay ?? null, entry.threadChannelId])] = entry.threadRootId;
    }
    const text = minerRootLine(netuid,persona);
    let rootId = threadRoots[scope]
      ?? await (relay ? io.find(persona,channelId,text,entry.threadRootId,relay) : io.find(persona,channelId,text,entry.threadRootId));
    if (compromised) throw compromised;
    rootId ??= await (relay ? io.post(persona,channelId,text,{relays:[relay]}) : io.post(persona,channelId,text));
    if (compromised) throw compromised;
    await updateState(home,state => {
      const current = state.miners.find(m => m.netuid === netuid && m.persona === persona);
      if (!current) throw Error("Miner was removed while opening its thread");
      return upsertMiner(state,{...current,threadChannelId:channelId,threadRootId:rootId,threadRelay:relay,
        threadRoots:{...current.threadRoots,...threadRoots,[scope]:rootId}});
    });
    return rootId;
  } finally {
    if (!compromised) await release();
  }
}
