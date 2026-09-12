import { expect, it } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { RelayConnection } from "../../../src/protocol/relay.js";
import { CapabilityClient } from "../../../src/protocol/client.js";
import { makeChannels } from "../../../src/protocol/channels.js";
import { bridgeTask, publishOnce, queryBridgeEvents, requireBridgeTarget, type BridgeNostr } from "../../fez-client/src/bridge-work.js";
import { completeWork, workResult } from "../../fez-client/src/work-completion.js";
import { makeStorage } from "../../../src/extensions/extension-storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MiniRelay } from "./mini-relay.js";

it("delivers one real signed bridge task through a lost acknowledgement and receives its worker result", async () => {
  const server = new MiniRelay();
  await server.start();
  const secret = new Uint8Array(32).fill(19), workerSecret = new Uint8Array(32).fill(20);
  const worker = getPublicKey(workerSecret);
  const client = new CapabilityClient({ relay: server.url, privateKey: Buffer.from(secret).toString("hex") });
  const relay = new RelayConnection({ url: server.url });
  const directory = await mkdtemp(join(tmpdir(), "fez-bridge-wire-"));
  try {
    await relay.connect();
    let loseAck = false;
    const nostr: BridgeNostr = {
      pubkey: client.pubkey, signEvent: t => client.signEvent(t),
      publish: async t => {
        const e = client.signEvent(t); await relay.publish(e);
        if (loseAck) { loseAck = false; throw Error("lost acknowledgement"); }
        return e;
      },
      query: filters => relay.query(filters), queryWithStatus: filters => relay.queryWithStatus(filters),
      encrypt: (pk, text) => client.encryptTo(pk, text), decrypt: (pk, text) => client.decryptFrom(pk, text),
    };
    const seed = (t: Omit<EventTemplate, "created_at">) => nostr.publish(t);
    await seed({ kind: 47101, tags: [["d", "work"]], content: '{"name":"Bridge work"}' });
    await seed({ kind: 47102, tags: [["d", "roster"], ["p", worker, "bot"]], content: "" });
    await seed({ kind: 47006, tags: [["p", worker]], content: "" });
    // makeChannels only needs the structural subset used by this test.
    const channels = makeChannels(nostr as Parameters<typeof makeChannels>[0], client.pubkey);
    await requireBridgeTarget(nostr, channels, "work", worker, client.pubkey);
    const template = bridgeTask({ channelId: "work", worker, content: "Reproduce the incident and prepare a draft fix" });
    loseAck = true;
    await expect(publishOnce(nostr, makeStorage("bridge", directory), "incident:1", template)).rejects.toThrow("lost acknowledgement");
    const request = await publishOnce(nostr, makeStorage("bridge", directory), "incident:1", template);
    expect(server.events.filter(e => e.tags.some(t => t[0] === "task"))).toHaveLength(1);
    const result = finalizeEvent({ ...completeWork(request, worker, { status: "success", summary: "Draft PR ready; failing regression now passes", capability: "coding", artifacts: ["https://github.com/example/project/pull/7"] }), created_at: Math.floor(Date.now() / 1000) }, workerSecret);
    await relay.publish(result);
    const delivered = await queryBridgeEvents(nostr, [{ kinds: [47103], authors: [worker], "#result": [request.id] }]);
    expect(delivered).toHaveLength(1);
    expect(workResult(delivered[0], request)).toBe("success");
    expect(delivered[0].tags).toContainEqual(["artifact", "https://github.com/example/project/pull/7"]);
  } finally {
    relay.disconnect(); await server.stop(); await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
