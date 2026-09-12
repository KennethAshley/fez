import { K, type Wire, type WireEvent, type WireFilter } from "./index.js";
import { WorkspaceState, replaceableEventWins, type Channel } from "./workspace-state.js";

export interface TeamMemory {
  state: WorkspaceState;
  channel: Channel;
  events: WireEvent[];
  windowed: boolean;
}

/** Both readers use a fresh, complete trust snapshot; a failed read is never an empty memory. */
export async function readTeamMemory(
  wire: Pick<Wire, "queryWithStatus">,
  owner: string | undefined,
  channel: string,
  reader: string,
  memoryId?: string,
): Promise<TeamMemory> {
  if (!owner) throw new Error("Could not establish the workspace owner. Team memory is unavailable; retry.");
  const query = async (filters: WireFilter[]) => {
    if (typeof wire.queryWithStatus !== "function") throw new Error("Team memory requires a backend that reports incomplete reads.");
    const result = await wire.queryWithStatus(filters);
    if (result.failures.length) throw new Error("Team memory read is incomplete. Check the relay connection and retry.");
    return result.events;
  };
  const state = new WorkspaceState();
  // This temporary trust snapshot must not save over the desktop's persisted workspace.
  state.workspace.owner = owner;
  const raw = channel.trim().replace(/^#/, "");
  const governance = await query([
    { kinds: [K.MEMBERSHIP], authors: [owner], "#d": [K.ROSTER_D] },
    { kinds: [K.CHANNEL], authors: [owner], limit: 500 },
    { kinds: [K.CHANNEL], authors: [owner], "#d": [raw] },
  ]);
  for (const event of governance) state.absorb(event);
  const moderators = [owner, ...[...state.workspace.members].filter(([, role]) => role === "admin").map(([pk]) => pk)];
  for (const event of await query([{ kinds: [K.BAN_LIST], authors: moderators, "#d": [K.BANS_D, K.REMOVED_D] }])) state.absorb(event);
  if (!state.isMember(reader)) throw new Error("Team memory requires current workspace membership.");
  const matches = [...state.workspace.channels.values()].filter(ch => ch.name.toLowerCase() === raw.toLowerCase());
  const resolved = state.workspace.channels.get(raw) ?? (matches.length === 1 ? matches[0] : undefined);
  if (!resolved) throw new Error(matches.length > 1 ? "Ambiguous channel name. Use its channel id." : `No trusted channel "${raw}" was found. Use its channel id or retry.`);
  const authors = [...new Set([owner, ...state.workspace.members.keys()])].filter(pk => state.isMember(pk));
  const scope = { authors, "#h": [resolved.id] };
  // ponytail: bounded history, disclosed by both readers; add per-relay paging when channels outgrow it.
  const events = await query(memoryId
    ? [{ ...scope, kinds: [K.MEMORY], ids: [memoryId] }]
    : [{ ...scope, kinds: [K.MEMORY, K.MEMORY_UPDATE], limit: 500 }]);
  if (memoryId && events[0]) {
    // Other members cannot crowd an author's actual corrections out of this read.
    const editors = [...new Set([events[0].pubkey, ...moderators])].filter(pk => state.isMember(pk));
    events.push(...await query([{ ...scope, authors: editors, kinds: [K.MEMORY_UPDATE], "#e": [memoryId], limit: 500 }]));
  }
  const windowed = events.length >= 500;
  // A correction can be recent even when its original fact lies outside the window.
  const ids = [...new Set(events.filter(e => e.kind === K.MEMORY_UPDATE).flatMap(e => e.tags.filter(t => t[0] === "e").map(t => t[1])))];
  if (ids.length && !memoryId) {
    const roots = await query([{ ...scope, kinds: [K.MEMORY], ids }]);
    const heads = teamMemoryHeads([...events, ...roots], resolved.id, state);
    // An unauthorized reference must not resurrect an obsolete original whose
    // real correction is older than the window.
    events.push(...roots.filter(root => heads.has(root.id) && heads.get(root.id)!.id !== root.id));
  }
  return { state, channel: resolved, events, windowed };
}

/** Stable original ids identify facts; author/moderator corrections select their current text. */
export function teamMemoryHeads(events: WireEvent[], channelId: string, state: WorkspaceState): Map<string, WireEvent> {
  const trusted = events.filter(e => state.isMember(e.pubkey) && !state.isRemoved(e.id)
    && e.tags.filter(t => t[0] === "h").length === 1 && e.tags.some(t => t[0] === "h" && t[1] === channelId));
  const roots = new Map(trusted.filter(e => e.kind === K.MEMORY && e.content.trim()).map(e => [e.id, e]));
  const heads = new Map(roots);
  for (const event of trusted) {
    if (event.kind !== K.MEMORY_UPDATE) continue;
    const targets = event.tags.filter(t => t[0] === "e");
    if (targets.length !== 1) continue;
    const root = roots.get(targets[0][1]);
    if (!root || event.created_at <= root.created_at || (event.pubkey !== root.pubkey && !state.canModerate(event.pubkey))) continue;
    if (replaceableEventWins(event, heads.get(root.id))) heads.set(root.id, event);
  }
  return heads;
}

export function buildTeamMemory(context: TeamMemory, writer: string, content: string, replaces?: string) {
  const text = content.trim();
  if ((!replaces && !text) || text.length > 4000) throw new Error("Memory must contain 1–4000 characters; only a correction may be empty.");
  if (!context.state.isMember(writer)) throw new Error("Team memory requires current workspace membership.");
  let created_at = Math.floor(Date.now() / 1000);
  const tags = [["h", context.channel.id]];
  if (replaces) {
    const root = context.events.find(e => e.id === replaces && e.kind === K.MEMORY);
    const head = teamMemoryHeads(context.events, context.channel.id, context.state).get(replaces);
    if (!root || !head) throw new Error("No trusted memory with that id in this channel. Recall its full original id first.");
    if (root.pubkey !== writer && !context.state.canModerate(writer)) throw new Error("Only the original author or a workspace moderator may correct or forget this memory.");
    created_at = Math.max(created_at, head.created_at + 1);
    tags.push(["e", replaces]);
  }
  return { kind: replaces ? K.MEMORY_UPDATE : K.MEMORY, content: text, tags, created_at };
}
