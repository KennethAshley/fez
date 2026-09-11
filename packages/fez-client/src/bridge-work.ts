import { WorkspaceState, replaceableEventWins } from "./workspace-state.js";
import { channelMessage } from "./channel-message.js";
export { channelMessage as bridgeMessage } from "./channel-message.js";

export interface BridgeEvent {
  id: string; kind: number; pubkey: string; created_at: number;
  tags: string[][]; content: string; sig?: string;
}
export interface BridgeTemplate { kind: number; tags: string[][]; content: string; created_at?: number }
/** These methods receive signature-verified events from the host's Nostr transport. */
export interface BridgeNostr {
  pubkey: string;
  signEvent(template: BridgeTemplate): BridgeEvent;
  publish(template: BridgeTemplate): Promise<BridgeEvent>;
  query(filters: Record<string, unknown>[]): Promise<BridgeEvent[]>;
  queryWithStatus?(filters: Record<string, unknown>[]): Promise<{ events: BridgeEvent[]; failures: { url: string; reason: string }[] }>;
  encrypt(peer: string, text: string): string;
  decrypt(peer: string, text: string): string;
}
export interface BridgeStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

const pubkey = (value: string) => /^[a-f0-9]{64}$/.test(value);
const contentOf = (event: BridgeTemplate) => JSON.stringify([event.kind, event.tags, event.content]);

export function bridgeScope(owner: string, relay: string | undefined): string {
  if (!pubkey(owner) || !relay || !/^wss?:\/\//.test(relay)) throw Error("A known owner and relay are required for bridge state");
  return JSON.stringify([owner, new URL(relay).href]);
}

/** Absence is meaningful for config and bans only after every subscription reached EOSE. */
export async function queryBridgeEvents(nostr: BridgeNostr, filters: Record<string, unknown>[]): Promise<BridgeEvent[]> {
  if (typeof nostr.queryWithStatus !== "function") throw Error("Update Fez: this host cannot verify complete bridge history");
  const result = await nostr.queryWithStatus(filters);
  if (result.failures.length) throw Error("Incomplete relay history; bridge work is paused until the relay responds");
  return result.events;
}

export async function readBridgeConfig<T>(nostr: BridgeNostr, name: string, parse: (raw: unknown) => T): Promise<T> {
  const d = `ext:${name}`;
  const events = await queryBridgeEvents(nostr, [{ kinds: [30078], authors: [nostr.pubkey], "#d": [d] }]);
  let newest: BridgeEvent | undefined;
  for (const event of events) {
    if (event.kind === 30078 && event.pubkey === nostr.pubkey && event.tags.some(t => t[0] === "d" && t[1] === d) && replaceableEventWins(event, newest)) newest = event;
  }
  if (!newest) return parse(undefined);
  try { return parse(JSON.parse(nostr.decrypt(nostr.pubkey, newest.content))); }
  catch { throw Error(`Cannot read ${name} config; repair it in extension settings`); }
}

/** Imported prose is never an additional summon signed on the owner's behalf. */
export function externalText(text: string, max = 8000): string {
  return text.slice(0, max).replace(/@/g, "＠").replace(/nostr:/gi, "nostr∶")
    .replace(/\b(npub|nprofile)1/gi, "$1\u200b1").replace(/\p{Cc}/gu, char => "\n\r\t".includes(char) ? char : "");
}

export function bridgeTask(opts: { channelId: string; worker: string; content: string; threadRoot?: string }): BridgeTemplate {
  if (!opts.channelId.trim() || opts.channelId.length > 200 || !pubkey(opts.worker) || !opts.content.trim() || opts.content.length > 16000 ||
    (opts.threadRoot !== undefined && !pubkey(opts.threadRoot))) throw Error("Invalid bridge task destination or content");
  const message = channelMessage({ ...opts, content: externalText(opts.content, 16000) });
  message.tags.push(["p", opts.worker], ["task", opts.worker], ["result-handler", "external"], ["depth", "1"]);
  return message;
}

export async function requireBridgeTarget(
  nostr: BridgeNostr, channels: { list(): Promise<{ id: string; name: string; archived?: boolean }[]> },
  channelId: string, worker: string, workspaceOwner: string | undefined,
): Promise<void> {
  if (!workspaceOwner || !pubkey(workspaceOwner) || !pubkey(worker) || worker === nostr.pubkey) throw Error("Choose an agent in a known workspace");
  if (typeof channels.list !== "function") throw Error("Update Fez: this host cannot list bridge channels");
  const roster = await queryBridgeEvents(nostr, [
    { kinds: [47102], authors: [workspaceOwner], "#d": ["roster"] },
  ]);
  const state = new WorkspaceState();
  state.workspace.owner = workspaceOwner;
  for (const event of roster) if (event.kind === 47102) state.absorb(event);
  const moderators = [workspaceOwner, ...[...state.workspace.members].filter(([, role]) => role === "admin").map(([pk]) => pk)];
  // Filter before the relay's result cap, so unrelated authors cannot hide a real ban.
  const events = await queryBridgeEvents(nostr, [
    { kinds: [30047], authors: moderators, "#d": ["bans"] },
    { kinds: [47101], authors: [workspaceOwner], "#d": [channelId] },
    { kinds: [47006], authors: [nostr.pubkey], "#p": [worker] },
  ]);
  for (const event of [...events].sort((a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id))) {
    if (event.kind !== 47102) state.absorb(event);
  }
  const channel = state.workspace.channels.get(channelId);
  if (!channel || channel.archived) throw Error("The bridge channel is unavailable or archived");
  if (!state.isMember(worker) || !state.isMember(nostr.pubkey)) throw Error("Bridge owner and agent must be current, unbanned workspace members");
  if (!events.some(e => e.kind === 47006 && e.pubkey === nostr.pubkey && e.tags.some(t => t[0] === "p" && t[1] === worker))) {
    throw Error("Choose an agent attested by this account");
  }
}

interface Delivery { event: BridgeEvent; input: string; delivered: boolean }
const queues = new WeakMap<BridgeStorage, Map<string, Promise<unknown>>>();

/** Persist before publishing. A lost relay ACK retries the same event, never a second task. */
export async function publishOnce(nostr: BridgeNostr, storage: BridgeStorage, key: string, template: BridgeTemplate): Promise<BridgeEvent> {
  let queue = queues.get(storage);
  if (!queue) { queue = new Map(); queues.set(storage, queue); }
  const previous = queue.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const input = contentOf(template);
    const storageKey = `publish:${key}`;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const source = `fez:bridge:${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("")}`;
    const prepared = { ...template, tags: [...template.tags, ["i", source]] };
    let saved = await storage.get<Delivery>(storageKey);
    if (saved && (saved.input !== input || !saved.event || saved.event.pubkey !== nostr.pubkey || contentOf(saved.event) !== contentOf(prepared))) {
      throw Error("Bridge delivery state belongs to a different task; refusing to overwrite it");
    }
    if (saved?.delivered) return saved.event;
    // The source tag also recovers a delivery after local state loss.
    const existing = (await queryBridgeEvents(nostr, [{ kinds: [template.kind], authors: [nostr.pubkey], "#i": [source] }]))
      .filter(e => e.pubkey === nostr.pubkey && e.kind === template.kind && e.tags.some(t => t[0] === "i" && t[1] === source))
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
    if (existing) {
      if (contentOf(existing) !== contentOf(prepared)) throw Error("Bridge source already has a different task");
      await storage.set(storageKey, { event: existing, input, delivered: true });
      return existing;
    }
    if (!saved) {
      if (typeof nostr.signEvent !== "function") throw Error("Update Fez: bridge delivery needs event signing");
      saved = { event: nostr.signEvent(prepared), input, delivered: false };
      await storage.set(storageKey, saved);
    }
    const delivered = await nostr.publish(saved.event);
    if (delivered.id !== saved.event.id) throw Error("Update Fez: this host changed a prepared bridge event's timestamp");
    await storage.set(storageKey, { ...saved, delivered: true });
    return delivered;
  });
  queue.set(key, next);
  try { return await next; }
  finally { if (queue.get(key) === next) queue.delete(key); }
}
