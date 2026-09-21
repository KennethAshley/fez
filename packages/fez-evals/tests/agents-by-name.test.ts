import { afterAll, beforeAll, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { CapabilityClient } from "../../../src/protocol/client.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";
import { KIND_AGENT_METADATA } from "../../../src/protocol/kinds.js";

const agent = generateSecretKey();
let relay: RelayHandle;
let client: CapabilityClient;

beforeAll(async () => {
  useWebSocketImplementation(WebSocket);
  const url = await new Promise<string>(resolve => {
    relay = startRelay({ port: 0, host: "127.0.0.1", onListening: port => resolve(`ws://127.0.0.1:${port}`), log: () => {} });
  });
  client = new CapabilityClient({ relay: url });
  await client.connect();
});
afterAll(() => { client?.disconnect(); relay?.close(); });

function announce(name: string, createdAt: number) {
  return relay.inject(finalizeEvent({ kind: KIND_AGENT_METADATA, created_at: createdAt, tags: [],
    content: JSON.stringify({ name, supported_tasks: ["channel-chat"] }) }, agent));
}

it("lists an agent once, by its newest announcement", async () => {
  const now = Math.floor(Date.now() / 1000);
  await announce("fez-old", now - 100);
  await announce("fez", now - 50);
  await announce("fez", now - 10);
  const agents = await client.findAgentsByName("fez");
  expect(agents).toHaveLength(1);
  expect(agents[0].name).toBe("fez");
});
