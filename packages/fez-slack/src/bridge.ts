import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools";
import { bridgeScope, bridgeTask, externalText, publishOnce, requireBridgeTarget, type BridgeEvent, type BridgeNostr, type BridgeStorage } from "../../fez-client/src/bridge-work.js";
import { workResult } from "../../fez-client/src/work-completion.js";
import { parseThreadRef } from "../../fez-client/src/thread-ref.js";
import { configKey, type Config } from "./config.js";

type Entry = { user: string; text: string; ts: string; thread: string; config: string; request?: BridgeEvent; acknowledged?: boolean; progress?: boolean; done?: boolean; cancelled?: boolean };
type State = { since: number; entries: Record<string, Entry>; threads: Record<string, string> };
export interface BridgeOptions {
  nostr: BridgeNostr;
  storage: BridgeStorage;
  relay?: string;
  workspaceOwner?: string;
  channels: { list(): Promise<{ id: string; name: string; archived?: boolean }[]> };
  config(): Promise<Config>;
  post(thread: string, text: string, id: string): Promise<void>;
  now?: () => number;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{10,}\.\d{1,6}$/.test(v);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class SlackBridge {
  private state!: State;
  private config!: Config;
  private bot = "";
  private key = "";
  private active = false;
  private writes: Promise<void> = Promise.resolve();
  private jobs: Promise<void> = Promise.resolve();
  private intake: Promise<void> = Promise.resolve();
  constructor(private readonly options: BridgeOptions) {}
  private now() { return this.options.now?.() ?? Math.floor(Date.now() / 1000); }
  async start(config: Config, bot: string): Promise<void> {
    this.config = config; this.bot = bot;
    this.key = `slack:${bridgeScope(this.options.nostr.pubkey, this.options.relay)}:${config.teamId}:${config.channelId}`;
    this.state = await this.options.storage.get<State>(this.key) ?? { since: this.now(), entries: {}, threads: {} };
    this.state.since = this.now();
    for (const entry of Object.values(this.state.entries)) if (entry.config !== configKey(config)) entry.cancelled = true;
    await this.save();
    this.active = config.enabled;
    this.enqueue(() => this.pending());
  }
  async stop(cancel = false): Promise<void> {
    this.active = false;
    if (cancel && this.state) {
      for (const entry of Object.values(this.state.entries)) if (!entry.done) entry.cancelled = true;
      this.state.since = this.now();
      await this.save();
    }
  }
  private save(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const write = this.writes.catch(() => {}).then(() => this.options.storage.set(this.key, snapshot));
    this.writes = write; return write;
  }
  private enqueue(job: () => Promise<void>): void {
    this.jobs = this.jobs.catch(() => {}).then(job);
    // The scheduled tick retries durable pending work; never leak an unhandled rejection.
    void this.jobs.catch(() => {});
  }
  async drain(): Promise<void> { await this.jobs; }
  private async allowed(entry?: Entry): Promise<boolean> {
    if (!this.active || entry?.cancelled || entry?.done) return false;
    if (configKey(await this.options.config()) !== configKey(this.config)) { await this.stop(true); return false; }
    return !entry || entry.config === configKey(this.config) && this.config.allowedUsers.includes(entry.user);
  }
  receive(raw: unknown, ack: () => void): Promise<void> {
    this.intake = this.intake.catch(() => {}).then(() => this.receiveOne(raw, ack));
    return this.intake;
  }
  private async receiveOne(raw: unknown, ack: () => void): Promise<void> {
    const envelope = object(raw), payload = object(envelope.payload), event = object(payload.event);
    if (envelope.type !== "events_api" || payload.type !== "event_callback" || payload.team_id !== this.config.teamId || payload.is_ext_shared_channel === true || event.type !== "app_mention" || event.channel !== this.config.channelId || event.team !== undefined && event.team !== this.config.teamId || event.user_team !== undefined && event.user_team !== this.config.teamId || event.bot_id || event.subtype || event.user === this.bot || !this.config.allowedUsers.includes(String(event.user)) || typeof event.text !== "string" || !event.text.includes(`<@${this.bot}>`) || !timestamp(event.ts) || event.thread_ts !== undefined && !timestamp(event.thread_ts) || typeof payload.event_id !== "string" || !/^Ev[A-Za-z0-9]{1,198}$/.test(payload.event_id)) { ack(); return; }
    // Keep the Socket Mode ACK independent of relay latency; process() rereads authorization.
    if (!this.active) { ack(); return; }
    const id = payload.event_id;
    if (Object.hasOwn(this.state.entries, id)) { ack(); return; }
    if (Number(event.ts) < Math.max(this.state.since, this.now() - 300) || Number(event.ts) > this.now() + 30) { ack(); return; }
    const entry: Entry = { user: String(event.user), text: externalText(event.text.replaceAll(`<@${this.bot}>`, ""), 8000), ts: event.ts, thread: typeof event.thread_ts === "string" ? event.thread_ts : event.ts, config: configKey(this.config) };
    this.state.entries[id] = entry;
    try { await this.save(); } catch (error) { delete this.state.entries[id]; throw error; }
    ack();
    this.enqueue(() => this.process(id, entry));
  }
  private async pending(): Promise<void> {
    // ponytail: one binding scans its retained journal; index pending IDs if this becomes large.
    for (const [id, entry] of Object.entries(this.state.entries)) await this.process(id, entry);
  }
  async retry(): Promise<void> { this.enqueue(() => this.pending()); await this.drain(); }
  private async process(id: string, entry: Entry): Promise<void> {
    if (!await this.allowed(entry)) return;
    const { nostr, storage, channels, workspaceOwner } = this.options;
    await requireBridgeTarget(nostr, channels, this.config.fezChannel, this.config.worker, workspaceOwner);
    if (!await this.allowed(entry)) return;
    if (!entry.request) {
      for (const previous of Object.values(this.state.entries)) {
        if (previous === entry) break;
        if (previous.thread === entry.thread && previous.config === entry.config && !previous.cancelled && !previous.request) return;
      }
      const guarded = { ...nostr, publish: async (template: Parameters<BridgeNostr["publish"]>[0]) => {
        await requireBridgeTarget(nostr, channels, this.config.fezChannel, this.config.worker, workspaceOwner);
        if (!await this.allowed(entry)) throw new Error("Slack bridge stopped before task publication");
        return nostr.publish(template);
      } };
      const threadKey = `${this.config.fezChannel}:${entry.thread}`;
      entry.request = await publishOnce(guarded, storage, `${this.key}:request:${id}`, bridgeTask({ channelId: this.config.fezChannel, worker: this.config.worker, content: `Request from approved Slack user ${entry.user}:\n\n${entry.text}`, threadRoot: this.state.threads[threadKey] }));
      this.state.threads[threadKey] ??= entry.request.id;
      await this.save();
    }
    if (!entry.acknowledged && await this.allowed(entry)) {
      await this.send(id, entry, "accepted", "Fez accepted your request. Waiting for the selected agent.");
      entry.acknowledged = true; await this.save();
    }
  }
  async result(event: BridgeEvent): Promise<void> {
    this.enqueue(async () => {
      if (event.kind !== 47103 || event.pubkey !== this.config.worker || !event.sig || !verifyEvent({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig })) return;
      for (const [id, entry] of Object.entries(this.state.entries)) {
        const request = entry.request;
        if (!request || !await this.allowed(entry)) continue;
        const status = workResult(event, request);
        if (status) {
          await requireBridgeTarget(this.options.nostr, this.options.channels, this.config.fezChannel, this.config.worker, this.options.workspaceOwner);
          if (!await this.allowed(entry)) continue;
          const artifacts = [...new Set(event.tags.filter(t => t[0] === "artifact").map(t => t[1]))];
          const links = artifacts.flatMap(value => {
            if (!/^https:\/\/\S{1,2048}$/.test(value)) return [];
            try { return [new URL(value).href]; } catch { return []; }
          }).slice(0, 8);
          const suffix = [...links, ...(artifacts.length > links.length ? ["Additional artifacts are available in Fez."] : [])].join("\n");
          await this.send(id, entry, "result", `${status === "error" ? "Failed: " : ""}${event.content.slice(0, 8000)}${suffix ? `\n\n${suffix}` : ""}`);
          entry.done = true; await this.save();
        } else if (!entry.progress && event.created_at >= request.created_at && event.tags.some(t => t[0] === "h" && t[1] === this.config.fezChannel) && parseThreadRef(event.tags).parentId === request.id && parseThreadRef(event.tags).rootId === (parseThreadRef(request.tags).rootId ?? request.id)) {
          await requireBridgeTarget(this.options.nostr, this.options.channels, this.config.fezChannel, this.config.worker, this.options.workspaceOwner);
          await this.send(id, entry, "progress", "The selected Fez agent is working on your request.");
          entry.progress = true; await this.save();
        }
      }
    });
    await this.drain();
  }
  requests(): BridgeEvent[] { return Object.values(this.state.entries).filter(entry => !entry.done && !entry.cancelled && entry.config === configKey(this.config)).flatMap(entry => entry.request ? [entry.request] : []); }
  private async send(id: string, entry: Entry, stage: string, text: string): Promise<void> {
    if (!await this.allowed(entry)) return;
    const hash = digest(`${this.key}:${id}:${stage}`);
    const clientId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    await this.options.post(entry.thread, text, clientId);
  }
}
