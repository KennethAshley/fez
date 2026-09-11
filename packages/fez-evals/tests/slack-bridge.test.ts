import activate from "../../fez-slack/src/headless.js";
import type { ScheduledTaskContext } from "../../fez-slack/src/api-types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { completeWork } from "../../fez-client/src/work-completion.js";
import { SlackBridge, type BridgeOptions } from "../../fez-slack/src/bridge.js";
import { parseConfig, type Config } from "../../fez-slack/src/config.js";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { SlackApi, SlackSocket, socketUrl } from "../../fez-slack/src/slack.js";

vi.mock("../../fez-client/src/bridge-work.js", async importOriginal => {
  const real = await importOriginal<typeof import("../../fez-client/src/bridge-work.js")>();
  return { ...real, requireBridgeTarget: vi.fn(async () => {}) };
});

const credentials = vi.hoisted(() => ({ bot: "xoxb-test", app: "xapp-test" }));
vi.mock("../../../src/extensions/mcp-servers.js", () => ({ keychainSecret: (_name: string, key: string) => key === "bot_token" ? credentials.bot : credentials.app }));

const ownerKey = generateSecretKey(), workerKey = generateSecretKey();
const owner = getPublicKey(ownerKey), worker = getPublicKey(workerKey);
const now = 1_800_000_000;
const configured: Config = { revision: "initial", enabled: true, teamId: "T123456", channelId: "C123456", allowedUsers: ["U123456"], fezChannel: "fez-channel", worker };
function fixture() {
  let config = { ...configured };
  const data = new Map<string, unknown>();
  const published: ReturnType<typeof finalizeEvent>[] = [];
  const sent: { thread: string; text: string; id: string }[] = [];
  const storage = { get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined, set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); } };
  const nostr = {
    pubkey: owner,
    signEvent: (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent({ ...event, created_at: event.created_at ?? now }, ownerKey),
    publish: async (event: Parameters<typeof finalizeEvent>[0] & { id?: string }) => { const signed = event.id ? event as ReturnType<typeof finalizeEvent> : finalizeEvent({ ...event, created_at: event.created_at ?? now }, ownerKey); published.push(signed); return signed; },
    query: async () => [], queryWithStatus: async () => ({ events: [], failures: [] }), encrypt: (_: string, text: string) => text, decrypt: (_: string, text: string) => text,
  };
  const options: BridgeOptions = { nostr, storage, relay: "wss://relay.example", workspaceOwner: owner, channels: { list: async () => [{ id: "fez-channel", name: "work" }] }, config: () => Promise.resolve(config), now: () => now, post: async (thread, text, id) => { sent.push({ thread, text, id }); } };
  const make = () => new SlackBridge(options);
  return { make, options, data, published, sent, setConfig: (next: Config) => { config = next; } };
}
function mention(id = "Ev1", extra: Record<string, unknown> = {}) {
  return { type: "events_api", envelope_id: id, payload: { type: "event_callback", team_id: "T123456", event_id: id, event: { type: "app_mention", user: "U123456", channel: "C123456", text: "<@UBOT123> review @other nostr:npub1malicious", ts: `${now}.000001`, ...extra } } };
}
afterEach(() => vi.restoreAllMocks());

describe("Slack bridge", () => {
  it("defaults off and rejects incomplete or malformed enabled configuration", () => {
    expect(parseConfig({}).enabled).toBe(false);
    expect(parseConfig({ ...configured, allowedUsers: [] }).enabled).toBe(false);
    expect(parseConfig({ ...configured, worker: "agent-name" }).enabled).toBe(false);
  });
  it("ACKs durable accepted mentions, publishes one assigned task, and keeps Slack thread correlation across restart", async () => {
    const f = fixture(), b = f.make();
    await b.start(configured, "UBOT123");
    const ack = vi.fn();
    await b.receive(mention("Ev1", { thread_ts: `${now - 30}.000001` }), ack);
    expect(ack).toHaveBeenCalledOnce();
    await b.drain();
    expect(f.published).toHaveLength(1);
    const request = f.published[0];
    expect(request.tags).toContainEqual(["task", worker]);
    expect(request.content).not.toContain("@other");
    expect(f.sent[0].thread).toBe(`${now - 30}.000001`);
    b.stop();
    const restarted = f.make(); await restarted.start(configured, "UBOT123");
    await restarted.receive(mention("Ev1"), vi.fn()); await restarted.drain();
    expect(f.published).toHaveLength(1);
    const result = finalizeEvent({ ...completeWork(request, worker, { status: "success", summary: "Reviewed", capability: "review", artifacts: [] }), created_at: now + 1 }, workerKey);
    await restarted.result(result); await restarted.drain();
    expect(f.sent.at(-1)?.text).toBe("Reviewed");
    expect(f.sent.at(-1)?.thread).toBe(`${now - 30}.000001`);
    await restarted.result(result); await restarted.drain();
    expect(f.sent.filter(s => s.text.includes("Reviewed"))).toHaveLength(1);
  });
  it("fails closed for bots, foreign channels/teams, unapproved users, absent exact app mention, stale events and disabled config", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123");
    for (const extra of [{ bot_id: "B123" }, { subtype: "bot_message" }, { channel: "COTHER" }, { user: "UOTHER" }, { text: "ordinary @fez text" }, { ts: `${now - 600}.000000` }]) await b.receive(mention(JSON.stringify(extra), extra), vi.fn());
    const foreign = mention("foreign"); foreign.payload.team_id = "TOTHER";
    await b.receive(foreign, vi.fn());
    f.setConfig({ ...configured, enabled: false });
    await b.receive(mention(), vi.fn()); await b.drain();
    expect(f.published).toHaveLength(0); expect(f.sent).toHaveLength(0);
  });
  it("does not import previously unseen events from before a restart", async () => {
    const f = fixture(), first = f.make(); await first.start(configured, "UBOT123"); await first.drain(); await first.stop();
    f.options.now = () => now + 30;
    const restarted = f.make(); await restarted.start(configured, "UBOT123");
    await restarted.receive(mention("EvOffline", { ts: `${now + 10}.000001` }), vi.fn()); await restarted.drain();
    expect(f.published).toHaveLength(0);
  });
  it("does not export unrelated, forged, wrong worker, or disabled results", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123");
    await b.receive(mention(), vi.fn()); await b.drain();
    const request = f.published[0];
    const template = completeWork(request, worker, { status: "success", summary: "private result", capability: "review", artifacts: [] });
    const valid = finalizeEvent({ ...template, created_at: now + 1 }, workerKey);
    await b.result({ ...valid, content: "forged" });
    await b.result(finalizeEvent({ ...template, created_at: now + 1 }, generateSecretKey()));
    await b.result(finalizeEvent({ ...template, tags: [["h", configured.fezChannel]], created_at: now + 1 }, workerKey));
    f.setConfig({ ...configured, enabled: false });
    await b.result(valid); await b.drain();
    expect(f.sent.some(s => s.text.includes("private result") || s.text.includes("forged"))).toBe(false);
  });
  it("returns result artifact URLs when the agent summary contains no link", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123");
    await b.receive(mention(), vi.fn()); await b.drain();
    const result = finalizeEvent({ ...completeWork(f.published[0], worker, { status: "success", summary: "Draft PR ready", capability: "review", artifacts: ["https://github.com/example/repo/pull/7"] }), created_at: now + 1 }, workerKey);
    await b.result(result);
    expect(f.sent.at(-1)?.text).toContain("https://github.com/example/repo/pull/7");
  });
  it("delivers full answers and follow-ups in the same thread, with blockers marked as failures", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123");
    const thread = `${now}.000001`;
    const replies = [
      { status: "success", summary: "Run the checks:\n```\nnpx tsc --noEmit\nnpm run evals\n```" },
      { status: "success", summary: "The second command runs Fez's integration tests." },
      { status: "error", summary: "The relay is unavailable. Reconnect before trying again." },
    ] as const;
    for (const [index, reply] of replies.entries()) {
      await b.receive(mention(`EvAnswer${index}`, { ts: `${now}.00000${index + 1}`, ...(index ? { thread_ts: thread } : {}) }), vi.fn());
      await b.drain();
      const request = f.published[index];
      if (index) expect(request.tags).toContainEqual(["e", f.published[0].id, "", "root"]);
      const result = finalizeEvent({ ...completeWork(request, worker, { ...reply, capability: "help", artifacts: [] }), created_at: now + 1 }, workerKey);
      await b.result(result);
      expect(f.sent.at(-1)).toMatchObject({ thread, text: `${reply.status === "error" ? "Failed: " : ""}${reply.summary}` });
    }
  });
  it("rechecks authorization after persisting the signed request, before actual publication", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123");
    const save = f.options.storage.set;
    f.options.storage.set = async (key, value) => { await save(key, value); if (key.startsWith("publish:")) f.setConfig({ ...configured, enabled: false }); };
    await b.receive(mention(), vi.fn()); await expect(b.drain()).rejects.toThrow();
    expect(f.published).toHaveLength(0);
  });
  it("does not let a later mention overtake an unprepared request in the same Slack thread", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123");
    const publish = f.options.nostr.publish; let first = true;
    f.options.nostr.publish = async event => { const result = await publish(event); if (first) { first = false; throw new Error("ambiguous publish"); } return result; };
    await b.receive(mention(), vi.fn()); await expect(b.drain()).rejects.toThrow();
    await b.receive(mention("EvSecond", { ts: `${now}.000002`, thread_ts: `${now}.000001` }), vi.fn()); await b.drain();
    expect(f.published).toHaveLength(1);
    await b.retry(); expect(f.published).toHaveLength(3);
    expect(f.published[2].tags).toContainEqual(["e", f.published[0].id, "", "root"]);
  });
  it("does not resurrect old work after disable and re-enable while the sentinel was offline", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123"); await b.receive(mention(), vi.fn()); await b.drain(); await b.stop();
    const next = { ...configured, revision: "saved-again" }; f.setConfig(next);
    const resumed = f.make(); await resumed.start(next, "UBOT123"); await resumed.drain();
    const result = finalizeEvent({ ...completeWork(f.published[0], worker, { status: "success", summary: "Old result", capability: "review", artifacts: [] }), created_at: now + 1 }, workerKey);
    await resumed.result(result); expect(f.sent.some(post => post.text.includes("Old result"))).toBe(false);
    await resumed.receive(mention("EvNew", { ts: `${now}.000002`, thread_ts: `${now}.000001` }), vi.fn()); await resumed.drain();
    expect(f.published[1].tags).toContainEqual(["e", f.published[0].id, "", "root"]);
  });
  it("ACKs a durable envelope without waiting on the relay authorization read", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123"); await b.drain();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.options.config = async () => { await pending; return configured; };
    const ack = vi.fn(), received = b.receive(mention(), ack);
    try { await new Promise(resolve => setTimeout(resolve, 0)); expect(ack).toHaveBeenCalledOnce(); }
    finally { release(); await received; await b.drain(); }
  });
  it("does not ACK a storage failure", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123");
    f.options.storage.set = async () => { throw new Error("disk full"); };
    const ack = vi.fn(); await expect(b.receive(mention(), ack)).rejects.toThrow("disk full");
    expect(ack).not.toHaveBeenCalled(); expect(f.published).toHaveLength(0);
  });
  it("retries an ambiguously published task with the same event ID and keeps follow-ups in the Fez thread", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123");
    const publish = f.options.nostr.publish;
    let failed = false;
    f.options.nostr.publish = async event => { const sent = await publish(event); if (!failed) { failed = true; throw new Error("connection lost after publish"); } return sent; };
    await b.receive(mention(), vi.fn()); await expect(b.drain()).rejects.toThrow("connection lost");
    await b.retry(); expect(f.published).toHaveLength(2);
    expect(f.published[0].id).toBe(f.published[1].id);
    await b.receive(mention("Ev2", { ts: `${now}.000002`, thread_ts: `${now}.000001` }), vi.fn()); await b.drain();
    expect(f.published[2].tags).toContainEqual(["e", f.published[0].id, "", "root"]);
  });
  it("serializes duplicate envelope intake until the first durable write finishes", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123"); await b.drain();
    const save = f.options.storage.set;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.options.storage.set = async (key, value) => { await pending; await save(key, value); };
    const ack1 = vi.fn(), ack2 = vi.fn();
    const first = b.receive(mention(), ack1), second = b.receive(mention(), ack2);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ack2).not.toHaveBeenCalled();
    release(); await Promise.all([first, second]); await b.drain();
    expect(f.published).toHaveLength(1); expect(ack1).toHaveBeenCalledOnce(); expect(ack2).toHaveBeenCalledOnce();
  });
  it("cancels pending export during a config change even when publish is in flight", async () => {
    const f = fixture(), b = f.make(); await b.start(configured, "UBOT123");
    const publish = f.options.nostr.publish;
    f.options.nostr.publish = async event => { const sent = await publish(event); f.setConfig({ ...configured, enabled: false }); return sent; };
    await b.receive(mention(), vi.fn()); await b.drain();
    expect(f.sent).toHaveLength(0);
    f.setConfig(configured); const restarted = f.make(); await restarted.start(configured, "UBOT123"); await restarted.drain();
    expect(f.sent).toHaveLength(0);
  });

});

describe("Slack transport trust boundary", () => {
  it("allows only Slack-owned secure socket URLs", () => {
    expect(socketUrl("wss://wss-primary.slack.com/link?ticket=secret")).toContain("slack.com");
    for (const url of ["ws://wss.slack.com", "wss://slack.com.evil.test", "wss://evilslack.com", "wss://x:y@wss.slack.com", "https://slack.com"]) expect(() => socketUrl(url)).toThrow();
  });
  it("uses same-thread posts, stable client message IDs, and masks transport errors", async () => {
    const requests: RequestInit[] = [];
    const api = new SlackApi("xoxb-supersecret", "xapp-supersecret", async (_url, init) => { requests.push(init!); return new Response(JSON.stringify({ ok: true, ts: "1.1" })); });
    await api.post("C123456", "12.3", "hello", "stable-id");
    expect(JSON.parse(String(requests[0].body))).toMatchObject({ channel: "C123456", thread_ts: "12.3", text: "hello", client_msg_id: "stable-id", unfurl_links: false, unfurl_media: false });
    const broken = new SlackApi("xoxb-supersecret", "xapp-supersecret", async () => { throw new Error("xoxb-supersecret xapp-supersecret"); });
    await expect(broken.identity()).rejects.toThrow(/Slack request failed/);
    await expect(broken.identity()).rejects.not.toThrow(/supersecret/);
  });
  it.each(["open", "post"] as const)("honors 429 Retry-After for %s across API instances without retrying early", async method => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "120" } }));
    const first = new SlackApi("xoxb-cooldown", "xapp-cooldown", fetcher), second = new SlackApi("xoxb-cooldown", "xapp-cooldown", fetcher);
    const request = (api: SlackApi) => method === "open" ? api.open() : api.post("C123456", "12.3", "hello", "stable-id");
    try {
      await expect(request(first)).rejects.toThrow();
      await expect(request(second)).rejects.toThrow(/rate limit|retry/i); expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(120_000); await expect(request(second)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("retries a temporary authorization-read outage before opening the socket", async () => {
    vi.useFakeTimers();
    const api = new SlackApi("xoxb-test", "xapp-test");
    const open = vi.spyOn(api, "open").mockRejectedValue(new Error("not connecting in this test"));
    let first = true;
    const connection = new SlackSocket(api, async () => {}, async () => { if (first) { first = false; throw new Error("relay unavailable"); } return true; }, vi.fn());
    try {
      await expect(connection.start()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000); expect(open).toHaveBeenCalledOnce();
    } finally { connection.stop(); vi.useRealTimers(); }
  });
  it("ACKs envelopes, answers transport heartbeat, reconnects, and stops reconnecting on disable", async () => {
    vi.useFakeTimers();
    class FakeSocket extends EventEmitter {
      readyState = WebSocket.OPEN;
      send = vi.fn(); ping = vi.fn();
      terminate() { this.emit("close"); }
      close() { this.emit("close"); }
    }
    const sockets: FakeSocket[] = [];
    const api = new SlackApi("xoxb-test", "xapp-test");
    vi.spyOn(api, "open").mockResolvedValue("wss://wss.slack.com/link");
    const connection = new SlackSocket(api, async (_event, ack) => ack(), async () => true, vi.fn(), () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    try {
      await connection.start(); sockets[0].emit("open");
      sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "events_api", envelope_id: "env" })));
      await Promise.resolve(); expect(sockets[0].send).toHaveBeenCalledWith('{"envelope_id":"env"}');
      await vi.advanceTimersByTimeAsync(30_000); expect(sockets[0].ping).toHaveBeenCalledOnce(); sockets[0].emit("pong");
      sockets[0].emit("message", Buffer.from('{"type":"disconnect","reason":"refresh_requested"}'));
      await vi.advanceTimersByTimeAsync(1000); expect(sockets).toHaveLength(2);
      connection.stop(); await vi.advanceTimersByTimeAsync(120_000); expect(sockets).toHaveLength(2);
    } finally { connection.stop(); vi.useRealTimers(); }
  });

});


it("activates only from the scheduled host, refreshes rotated credentials, and stops on disable", async () => {
  const f = fixture();
  let config = { ...configured };
  f.options.nostr.queryWithStatus = async () => ({ events: [{ id: "config", pubkey: owner, kind: 30078, created_at: now, content: JSON.stringify(config), tags: [["d", "ext:fez-slack"]] }], failures: [] });
  const identity = vi.spyOn(SlackApi.prototype, "identity").mockResolvedValue({ team: configured.teamId, bot: "UBOT123" });
  const start = vi.spyOn(SlackSocket.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(SlackSocket.prototype, "stop").mockImplementation(() => {});
  let tick!: (ctx: ScheduledTaskContext) => void | Promise<void>;
  activate({ storage: f.options.storage, workspace: { owner, relayUrl: f.options.relay }, registerScheduledTask: (_name, _ms, run) => { tick = run; } });
  const ctx: ScheduledTaskContext = { nostr: { ...f.options.nostr, subscribe: () => () => {} }, ownerPubkey: owner, channels: f.options.channels, missedWindow: false };
  expect(identity).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  await tick(ctx); expect(start).toHaveBeenCalledOnce();
  credentials.bot = "xoxb-rotated";
  await tick(ctx); expect(start).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalled();
  config = { ...config, enabled: false }; await tick(ctx); expect(stop).toHaveBeenCalledTimes(2);
  credentials.bot = "xoxb-test";
});
