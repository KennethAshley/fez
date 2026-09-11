import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { matchFilters, type Event, type Filter } from "nostr-tools";
import { RelayConnection } from "../../../src/protocol/relay.js";
import { BrowserWire } from "../../fez-desktop/src/wire.js";
import { FezClient, K } from "../../fez-client/src/index.js";

const key = generateSecretKey();
const message = (content: string, kind = K.MESSAGE) => finalizeEvent({
  kind, content, created_at: 100, tags: [["h", "a"]],
}, key);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A real socket peer; only relay responses are controlled by the test. */
async function peer(mode: "complete" | "closed" | "silent" | "drop", events: Event[] = [], auth = false) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing relay port");
  const state = { mode, events, rejected: 0, requests: [] as Filter[][] };
  server.on("connection", socket => {
    let authed = !auth;
    socket.on("message", bytes => {
      const [type, id, ...filters] = JSON.parse(bytes.toString());
      if (type === "AUTH") {
        authed = true;
        socket.send(JSON.stringify(["OK", id.id, true, ""]));
      }
      if (type !== "REQ") return;
      state.requests.push(filters);
      if (filters.length > 1) {
        socket.send(JSON.stringify(["CLOSED", id, "restricted: one filter per request"]));
        return;
      }
      if (!authed) {
        state.rejected++;
        socket.send(JSON.stringify(["AUTH", "history-challenge"]));
        socket.send(JSON.stringify(["CLOSED", id, "auth-required: sign in"]));
        return;
      }
      for (const event of state.events.filter(e => matchFilters(filters, e))) {
        socket.send(JSON.stringify(["EVENT", id, event]));
      }
      if (state.mode === "complete") socket.send(JSON.stringify(["EOSE", id]));
      if (state.mode === "closed") socket.send(JSON.stringify(["CLOSED", id, "restricted: read denied"]));
      if (state.mode === "drop") socket.close();
    });
  });
  const close = () => new Promise<void>(resolve => {
    for (const socket of server.clients) socket.terminate();
    server.close(() => resolve());
  });
  cleanups.push(close);
  return { url: `ws://127.0.0.1:${address.port}/`, state, close };
}

function connection(urls: string[], auth = false) {
  const relay = new RelayConnection({ urls, authSigner: auth ? async t => finalizeEvent(t, key) : undefined });
  cleanups.push(() => relay.disconnect());
  return relay;
}

describe("history query completion on the wire", () => {
  it("requires a real EOSE even for an empty result", async () => {
    const server = await peer("complete");
    const relay = connection([server.url]);
    expect(await relay.queryWithStatus([{ kinds: [K.MESSAGE] }], 300)).toEqual({ events: [], failures: [] });
    server.state.mode = "silent";
    const result = await relay.queryWithStatus([{ kinds: [K.MESSAGE] }], 100);
    expect(result.events).toEqual([]);
    expect(result.failures).toEqual([{ url: server.url, reason: "history query timed out" }]);
  });

  it.each(["closed", "silent", "drop"] as const)("retains partial events when the relay is %s", async mode => {
    const event = message("partial");
    const server = await peer(mode, [event]);
    const result = await connection([server.url]).queryWithStatus([{ kinds: [K.MESSAGE] }], 300);
    expect(result.events.map(e => e.id)).toEqual([event.id]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].url).toBe(server.url);
    expect(result.failures[0].reason).toBeTruthy();
  });

  it("reports a refused connection instead of a successful empty history", async () => {
    const server = await peer("complete");
    await server.close();
    const result = await connection([server.url]).queryWithStatus([{ kinds: [K.MESSAGE] }], 300);
    expect(result.events).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("merges and deduplicates partial relay results and recovers on retry", async () => {
    const shared = message("shared");
    const other = message("other", K.REACTION);
    const good = await peer("complete", [shared]);
    const failing = await peer("closed", [shared, other]);
    const relay = connection([good.url, failing.url]);
    const filters = [{ kinds: [K.MESSAGE] }, { kinds: [K.REACTION] }];
    const partial = await relay.queryWithStatus(filters, 500);
    expect(partial.events.map(e => e.id).sort()).toEqual([shared.id, other.id].sort());
    expect(partial.failures.map(f => f.url)).toEqual([failing.url]);
    expect(good.state.requests).toEqual(filters.map(filter => [filter]));
    failing.state.mode = "complete";
    expect((await relay.queryWithStatus(filters, 500)).failures).toEqual([]);
    expect((await relay.query(filters, 500)).map(e => e.id).sort()).toEqual([shared.id, other.id].sort());
  });

  it("reissues an auth-required query after NIP-42 authentication", async () => {
    const event = message("private");
    const server = await peer("complete", [event], true);
    const result = await connection([server.url], true).queryWithStatus([{ kinds: [K.MESSAGE] }], 1000);
    expect(server.state.rejected).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    expect(result.events.map(e => e.id)).toEqual([event.id]);
  });

  it("carries failure and recovery through the desktop wire into channel state", async () => {
    const event = message("cached");
    const server = await peer("closed", [event], true);
    const wire = new BrowserWire([server.url], Buffer.from(key).toString("hex"));
    cleanups.push(() => wire.close());
    const client = new FezClient(wire);
    client.state.workspace.members.set(event.pubkey, "owner");
    await client.loadChannelHistory("a");
    expect(client.historyState("a")).toMatchObject({ status: "error", partial: true });
    expect(client.messages("a").map(m => m.id)).toEqual([event.id]);
    server.state.mode = "complete";
    await client.loadChannelHistory("a");
    expect(client.historyState("a").status).toBe("ready");
    expect(client.messages("a").map(m => m.id)).toEqual([event.id]);
  });
});
