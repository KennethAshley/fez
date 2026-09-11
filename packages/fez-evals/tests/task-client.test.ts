import { afterAll, beforeAll, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { CapabilityClient } from "../../../src/protocol/client.js";
import { startRelay, type RelayHandle, type StoredEvent } from "../../fez-relay/src/relay.js";
import { KIND_AGENT_TASK, KIND_AGENT_RESULT, KIND_AGENT_PROGRESS } from "../../../src/protocol/kinds.js";

const target = generateSecretKey();
const stranger = generateSecretKey();
let relay: RelayHandle;
let client: CapabilityClient;
let nextTask: ((event: StoredEvent) => void) | undefined;

beforeAll(async () => {
  useWebSocketImplementation(WebSocket);
  const url = await new Promise<string>(resolve => {
    relay = startRelay({ port: 0, host: "127.0.0.1", onListening: port => resolve(`ws://127.0.0.1:${port}`), log: () => {} });
  });
  relay.onEvent(event => { if (event.kind === KIND_AGENT_TASK) nextTask?.(event); });
  client = new CapabilityClient({ relay: url });
  await client.connect();
});
afterAll(() => { client?.disconnect(); relay?.close(); });

const taskArrives = () => new Promise<StoredEvent>(resolve => { nextTask = resolve; });
function reply(task: StoredEvent, key = target, kind = KIND_AGENT_RESULT, content = '{"status":"success","result":{"text":"expected"}}') {
  return relay.inject(finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000),
    tags: [["e", task.id], ["p", client.getPubkey()]], content }, key));
}

it("waits for the requested signer instead of accepting another agent's forged result", async () => {
  const arrived = taskArrives();
  const result = client.sendTask({ to: getPublicKey(target), taskType: "test", instruction: "check signer", timeoutMs: 1500 });
  const task = await arrived;
  await reply(task, stranger, KIND_AGENT_RESULT, '{"status":"success","result":{"text":"forged"}}');
  // Give the forged response its own delivery turn; a newer legitimate stored result
  // can otherwise arrive first and hide the missing author check in the old client.
  await new Promise(resolve => setTimeout(resolve, 50));
  await reply(task);
  expect((await result).result).toEqual({ text: "expected" });
});

it("delivers progress from the requested signer and ignores malformed result envelopes", async () => {
  const progress: string[] = [];
  const arrived = taskArrives();
  const result = client.sendTask({ to: getPublicKey(target), taskType: "test", instruction: "check progress", timeoutMs: 1500,
    onProgress: event => progress.push(event.content) });
  const task = await arrived;
  await reply(task, stranger, KIND_AGENT_PROGRESS, '{"message":"forged progress"}');
  await reply(task, target, KIND_AGENT_PROGRESS, '{"message":"working"}');
  await reply(task, target, KIND_AGENT_RESULT, '{"status":42}');
  await reply(task);
  expect((await result).status).toBe("success");
  expect(progress).toEqual(['{"message":"working"}']);
});

it("bounds a wait and ignores a late result", async () => {
  const arrived = taskArrives();
  const result = client.sendTask({ to: getPublicKey(target), taskType: "test", instruction: "wait bound", timeoutMs: 100 });
  const failure = expect(result).rejects.toThrow(/timed out/i);
  const task = await arrived;
  await failure;
  await reply(task);
});

it("aborts before publication or during a wait and rejects invalid timeout values", async () => {
  const opts = { to: getPublicKey(target), taskType: "test", instruction: "cancel" };
  const before = relay.query({ kinds: [KIND_AGENT_TASK] }).length;
  await expect(client.sendTask({ ...opts, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  for (const timeoutMs of [0, -1, NaN, 0.5, Number.MAX_SAFE_INTEGER]) {
    await expect(client.sendTask({ ...opts, timeoutMs })).rejects.toThrow(/timeout/i);
  }
  expect(relay.query({ kinds: [KIND_AGENT_TASK] })).toHaveLength(before);
  const controller = new AbortController();
  const arrived = taskArrives();
  const result = client.sendTask({ ...opts, signal: controller.signal, timeoutMs: 1500 });
  const failure = expect(result).rejects.toMatchObject({ name: "AbortError" });
  const task = await arrived;
  controller.abort();
  await failure;
  await reply(task);
});

it("reports a publish refusal without waiting for the task timeout", async () => {
  relay.policies.push({ name: "refuse", onEvent: () => ({ accept: false, reason: "blocked by test" }) });
  try {
    await expect(client.sendTask({ to: getPublicKey(target), taskType: "test", instruction: "refused", timeoutMs: 1500 }))
      .rejects.toThrow(/blocked by test/);
  } finally { relay.policies.pop(); }
});
