import fs from "node:fs/promises";
import path from "node:path";
import { readState, updateState, upsertMiner } from "./state.js";
import { minerRootLine } from "./thread.js";
import { findPersonaRoot, postAsPersona } from "./persona-post.js";

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
  // ponytail: serialize local GUI/reconcile posts. After a hard crash, remove
  // thread.lock manually; relay lookup recovers a root whose state write failed.
  const lockPath = path.join(dir,"thread.lock");
  const lock = await fs.open(lockPath,"wx").catch(() => { throw Error("Miner thread is being opened; retry in a moment"); });
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
    const rootId = threadRoots[scope]
      ?? await (relay ? io.find(persona,channelId,text,entry.threadRootId,relay) : io.find(persona,channelId,text,entry.threadRootId))
      ?? await (relay ? io.post(persona,channelId,text,{relays:[relay]}) : io.post(persona,channelId,text));
    await updateState(home,state => {
      const current = state.miners.find(m => m.netuid === netuid && m.persona === persona);
      if (!current) throw Error("Miner was removed while opening its thread");
      return upsertMiner(state,{...current,threadChannelId:channelId,threadRootId:rootId,threadRelay:relay,
        threadRoots:{...current.threadRoots,...threadRoots,[scope]:rootId}});
    });
    return rootId;
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}
