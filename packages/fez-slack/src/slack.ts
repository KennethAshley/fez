import WebSocket from "ws";
import { createHash } from "node:crypto";

const cooldowns = new Map<string, number>();

export function socketUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Slack returned no socket URL");
  const url = new URL(raw);
  if (url.protocol !== "wss:" || url.username || url.password || url.port && url.port !== "443" || !(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))) throw new Error("Slack returned an unsafe socket URL");
  return url.href;
}

export class SlackApi {
  constructor(private readonly botToken: string, private readonly appToken: string, private readonly fetcher: typeof fetch = fetch, private readonly signal?: AbortSignal) {}
  private async call(method: string, body: Record<string, unknown> = {}, app = false): Promise<Record<string, unknown>> {
    const token = app ? this.appToken : this.botToken;
    const cooldownKey = createHash("sha256").update(`${method}:${token}`).digest("hex");
    const rateLimited = () => (cooldowns.get(cooldownKey) ?? 0) > Date.now();
    if (rateLimited()) throw new Error(`Slack rate limit (${method}); retry after the cooldown.`);
    cooldowns.delete(cooldownKey);
    try {
      const response = await this.fetcher(`https://slack.com/api/${method}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(this.signal ? [this.signal] : [])]), redirect: "error",
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After"));
        cooldowns.set(cooldownKey, Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000);
      }
      if (!response.ok) throw new Error("http_error");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new Error("api_error");
      return result as Record<string, unknown>;
    } catch {
      if (rateLimited()) throw new Error(`Slack rate limit (${method}); retry after the cooldown.`);
      // Never surface fetch errors: they can contain Authorization or the socket ticket.
      throw new Error(`Slack request failed (${method}); check connection, tokens and app permissions.`);
    }
  }
  async identity(): Promise<{ team: string; bot: string }> {
    const value = await this.call("auth.test");
    if (typeof value.team_id !== "string" || typeof value.user_id !== "string" || !value.bot_id) throw new Error("Slack bot identity is unavailable");
    return { team: value.team_id, bot: value.user_id };
  }
  async open(): Promise<string> { return socketUrl((await this.call("apps.connections.open", {}, true)).url); }
  async post(channel: string, thread: string, text: string, id: string): Promise<void> {
    await this.call("chat.postMessage", { channel, thread_ts: thread, text, client_msg_id: id, mrkdwn: false, parse: "none", link_names: false, unfurl_links: false, unfurl_media: false });
  }
}

export class SlackSocket {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = false;
  private failures = 0;
  constructor(private readonly api: SlackApi, private readonly receive: (event: unknown, ack: () => void) => Promise<void>, private readonly current: () => Promise<boolean>, private readonly warn: () => void, private readonly connect: (url: string) => WebSocket = url => new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 1_000_000 })) {}
  async start(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!await this.current()) return;
      const url = await this.api.open();
      if (this.stopped || !await this.current()) return;
      const socket = this.connect(url); this.socket = socket;
      let alive = true;
      socket.on("open", () => {
        this.failures = 0;
        this.heartbeat = setInterval(() => { if (!alive) { socket.terminate(); return; } alive = false; socket.ping(); }, 30_000);
        this.heartbeat.unref();
      });
      socket.on("pong", () => { alive = true; });
      socket.on("message", data => {
        let envelope: unknown;
        try { envelope = JSON.parse(data.toString()); } catch { return; }
        if (!envelope || typeof envelope !== "object") return;
        const value = envelope as Record<string, unknown>;
        if (value.type === "disconnect") { socket.close(); return; }
        if (typeof value.envelope_id !== "string") return;
        void this.receive(envelope, () => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: value.envelope_id }));
        }).catch(() => this.warn());
      });
      socket.on("error", () => { this.warn(); socket.terminate(); });
      socket.on("close", () => { clearInterval(this.heartbeat); this.schedule(); });
    } catch { this.warn(); this.schedule(); }
  }
  private schedule(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.start().catch(() => this.warn()); }, Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6)));
    this.retry.unref();
  }
  stop(): void { this.stopped = true; clearTimeout(this.retry); clearInterval(this.heartbeat); this.socket?.terminate(); }
}
