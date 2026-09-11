import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "node:http";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, type HarnessAdapter, type Persona } from "@fezchat/protocol";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";
import { membershipPolicy } from "../../fez-relay/src/policies.js";

// Actual runtime, signed events, NIP-42 and membership-gated relay; only
// persona/key storage and model execution are replaced with local fixtures.
const fixture = vi.hoisted(() => ({ dir: "", url: "", key: "", harness: undefined as HarnessAdapter | undefined }));
vi.mock("node:os", async original => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => fixture.dir } };
});
vi.mock("@fezchat/protocol", async original => {
  const actual = await original<typeof import("@fezchat/protocol")>();
  return {
    ...actual, registerBuiltinHarnesses: () => {}, findHarness: () => fixture.harness,
    findPersona: async (): Promise<Persona> => ({ id: "startup-test", harness: "controlled", aliases: [],
      mcpServers: [], mcpSources: {}, skills: [], skillSources: {}, skillSettings: {}, extra: {}, createdAt: "2026-09-10" }),
    loadOrCreateKey: () => fixture.key, loadSettings: () => ({}), skillsInstalled: () => [],
    resolveRelays: () => [fixture.url],
  };
});

let relay: RelayHandle, ownerWire: RelayConnection;
let ownerKey: Uint8Array, coordinatorKey: Uint8Array, agentPk: string, ownerPk: string, coordinatorPk: string;
let prompts: string[], intervals: ReturnType<typeof setInterval>[];
let connections: RelayConnection[];
let priorExit: NodeJS.ExitListener[], priorSigint: NodeJS.SignalsListener[];
const channel = "00000000-0000-0000-0000-000000000091";
let rosterTime: number;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(async () => {
  vi.resetModules();
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-startup-handoff-"));
  ownerKey = generateSecretKey(); coordinatorKey = generateSecretKey();
  const agentKey = generateSecretKey(); fixture.key = Buffer.from(agentKey).toString("hex");
  ownerPk = getPublicKey(ownerKey); agentPk = getPublicKey(agentKey); coordinatorPk = getPublicKey(coordinatorKey);
  priorExit = process.listeners("exit"); priorSigint = process.listeners("SIGINT");
  intervals = []; connections = []; prompts = []; rosterTime = Math.floor(Date.now() / 1000);
  const connect = RelayConnection.prototype.connect;
  vi.spyOn(RelayConnection.prototype, "connect").mockImplementation(function (this: RelayConnection) {
    connections.push(this); return connect.call(this);
  });
  const nativeInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args); intervals.push(timer); return timer;
  }) as typeof setInterval);
  vi.spyOn(process, "exit").mockImplementation(code => { throw new Error(`unexpected exit ${code}`); });
  for (const [name, value] of Object.entries({ FEZ_AGENT_PERSONA: "startup-test", FEZ_AGENT_CHANNELS: channel,
    FEZ_AGENT_OWNER: ownerPk, FEZ_AGENT_RESPOND_TO: "owner", FEZ_AGENT_REPO: "", FEZ_HIRE_TASK: "" })) vi.stubEnv(name, value);
  fixture.harness = { id: "controlled", aliases: [], command: "controlled", detect: async () => true,
    invoke: async () => { throw new Error("persistent session expected"); },
    openSession: async () => ({ alive: true, close: async () => {}, prompt: async input => {
      prompts.push(typeof input === "string" ? input : input.text); return "STARTUP_DONE";
    } }),
  };
  await new Promise<void>(resolve => {
    const listen = Server.prototype.listen;
    const listener = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
      this.once("listening", () => {
        const address = this.address();
        if (!address || typeof address === "string") throw new Error("Expected a local relay port");
        fixture.url = `ws://127.0.0.1:${address.port}`;
        resolve();
      });
      return listen.call(this, 0, "127.0.0.1");
    });
    relay = startRelay({ port: 0, workspace: { owner: ownerPk },
      policies: [membershipPolicy(ownerPk)], log: () => {},
    });
    listener.mockRestore();
  });
  ownerWire = new RelayConnection({ urls: [fixture.url], authSigner: async t => finalizeEvent(t, ownerKey) });
  await ownerWire.connect();
  await ownerWire.publish(finalizeEvent({ kind: 47006, tags: [["p", coordinatorPk]], content: "",
    created_at: rosterTime }, ownerKey));
});

afterEach(async () => {
  for (const timer of intervals) clearInterval(timer);
  for (const connection of connections) connection.disconnect();
  await relay?.close();
  for (const listener of process.listeners("exit")) if (!priorExit.includes(listener)) {
    listener(0); process.removeListener("exit", listener);
  }
  for (const listener of process.listeners("SIGINT")) if (!priorSigint.includes(listener)) process.removeListener("SIGINT", listener);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

async function enroll(includeAgent: boolean) {
  await ownerWire.publish(finalizeEvent({ kind: 47102, created_at: rosterTime++, content: "",
    tags: [["d", "roster"], ["p", ownerPk, "owner"], ["p", coordinatorPk, "bot"], ...(includeAgent ? [["p", agentPk, "bot"]] : [])],
  }, ownerKey));
}

it.each([false, true])("recovers a completion without a mention after restart (already answered: %s)", async answered => {
  await enroll(true);
  const agentKey = Buffer.from(fixture.key, "hex");
  const now = Math.floor(Date.now() / 1000);
  const request = finalizeEvent({ kind: 47103, created_at: now, content: "Make audio",
    tags: [["h", channel], ["task", coordinatorPk], ["p", coordinatorPk]] }, agentKey);
  const result = finalizeEvent({ kind: 47103, created_at: now, content: "Audio delivered",
    tags: [["h", channel], ["e", request.id, "", "root"], ["e", request.id, "", "reply"],
      ["p", agentPk], ["result", request.id], ["status", "success"]] }, coordinatorKey);
  await ownerWire.publish(request);
  await ownerWire.publish(result);
  if (answered) await ownerWire.publish(finalizeEvent({ kind: 47103, created_at: now, content: "Delivered to the user",
    tags: [["h", channel], ["e", request.id, "", "root"], ["e", result.id, "", "reply"]] }, agentKey));
  await import("../../fez-acp/src/agent.js");
  if (answered) {
    await pause(9500);
    expect(prompts).toHaveLength(0);
  } else {
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 12000 });
    expect(prompts[0]).toContain(result.id);
  }
}, 15000);

it.each(["startup", "live"])("leaves externally handled results to their requester (%s)", async delivery => {
  await enroll(true);
  if (delivery === "live") {
    await import("../../fez-acp/src/agent.js");
    // Installed last, after the runtime's channel listener and startup backfill.
    await vi.waitFor(() => expect(process.listeners("SIGINT").length).toBeGreaterThan(priorSigint.length), { timeout: 10000 });
  }
  const agentKey = Buffer.from(fixture.key, "hex");
  // Older results exercise completion recovery independently of mention backfill.
  const now = Math.floor(Date.now() / 1000) - (delivery === "startup" ? 180 : 0);
  const results = [];
  for (const mode of ["external-legacy-result", "external-marked-result", "normal"]) {
    const external = mode !== "normal";
    const request = finalizeEvent({ kind: 47103, created_at: now, content: `Make audio: ${mode}`,
      tags: [["h", channel], ["task", coordinatorPk], ["p", coordinatorPk],
        ...(external ? [["result-handler", "external"]] : [])] }, agentKey);
    const result = finalizeEvent({ kind: 47103, created_at: now,
      content: `${external ? "@startup-test " : ""}${mode}: audio delivered`,
      tags: [["h", channel], ["e", request.id, "", "root"], ["e", request.id, "", "reply"],
        ["p", agentPk], ["result", request.id], ["status", "success"],
        ...(mode === "external-marked-result" ? [["result-handler", "external"]] : [])] }, coordinatorKey);
    await ownerWire.publish(request);
    await ownerWire.publish(result);
    results.push(result);
  }
  if (delivery === "startup") await import("../../fez-acp/src/agent.js");
  const normalResult = results.at(-1)!;
  await vi.waitFor(() => expect(prompts.some(prompt => prompt.includes(normalResult.id))).toBe(true), { timeout: 12000 });
  await vi.waitFor(async () => {
    const replies = await ownerWire.query([{ kinds: [47103], authors: [agentPk], "#e": [normalResult.id] }]);
    expect(replies.some(e => e.content === "STARTUP_DONE" && e.tags.some(t => t[0] === "e" && t[1] === normalResult.id && t[3] === "reply"))).toBe(true);
  }, { timeout: 6000 });
  await pause(500);
  // A mention cannot bypass the signed request's handler. A legacy specialist
  // result without the propagated marker must obey that same request, too.
  expect(prompts.some(prompt => prompt.includes("external-legacy-result"))).toBe(false);
  expect(prompts.some(prompt => prompt.includes("external-marked-result"))).toBe(false);
  expect(prompts).toHaveLength(1);
}, 20000);

it("dispatches an authorized peer's explicit task without treating a bare p-tag as work", async () => {
  await enroll(true);
  await import("../../fez-acp/src/agent.js");
  await vi.waitFor(() => expect(process.listeners("SIGINT").length).toBeGreaterThan(priorSigint.length), { timeout: 10000 });
  const now = Math.floor(Date.now() / 1000);
  const reply = finalizeEvent({ kind: 47103, created_at: now, content: "BARE_REPLY_TAG",
    tags: [["h", channel], ["p", agentPk]] }, coordinatorKey);
  const assignment = finalizeEvent({ kind: 47103, created_at: now, content: "EXPLICIT_TASK_WITHOUT_MENTION",
    tags: [["h", channel], ["p", agentPk], ["task", agentPk]] }, coordinatorKey);
  await ownerWire.publish(reply);
  await ownerWire.publish(assignment);
  await vi.waitFor(() => expect(prompts.some(prompt => prompt.includes(assignment.id))).toBe(true), { timeout: 6000 });
  await vi.waitFor(async () => {
    const replies = await ownerWire.query([{ kinds: [47103], authors: [agentPk], "#e": [assignment.id] }]);
    expect(replies.some(e => e.content === "STARTUP_DONE" && e.tags.some(t => t[0] === "e" && t[1] === assignment.id && t[3] === "reply"))).toBe(true);
  }, { timeout: 6000 });
  await pause(200);
  expect(prompts.some(prompt => prompt.includes("BARE_REPLY_TAG"))).toBe(false);
  expect(prompts).toHaveLength(1);
}, 20000);

it.each(["before boot", "during boot", "after announcement"])("recovers a signed specialist handoff once (enrollment: %s)", async enrollment => {
  await enroll(enrollment === "before boot");
  const request = finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000) - 1,
    tags: [["h", channel]], content: "@startup-test Complete FIRST_HANDOFF and return the result here." }, coordinatorKey);
  await ownerWire.publish(request);
  let announced = false;
  ownerWire.subscribe([{ kinds: [47000], authors: [agentPk] }], () => { announced = true; });
  let claiming = false;
  ownerWire.subscribe([{ kinds: [20001], authors: [agentPk] }], () => { claiming = true; });
  await import("../../fez-acp/src/agent.js");
  if (enrollment === "during boot") {
    // The first roster snapshot has happened, but the runtime is still
    // claiming its identity and has not installed its message listener.
    await vi.waitFor(() => expect(claiming).toBe(true), { timeout: 5_000 });
    await enroll(true);
  }
  await vi.waitFor(() => expect(announced).toBe(true), { timeout: 10_000 });
  if (enrollment === "after announcement") {
    // Reproduce the app's announce → invite delay. Before enrollment,
    // history is invisible; it must be recovered when access arrives.
    await pause(500);
    expect(prompts).toHaveLength(0);
    await enroll(true);
  }
  const replies = async () => (await ownerWire.query([{ kinds: [47103], authors: [agentPk] }]))
    .filter(e => e.tags.some(t => t[0] === "e" && t[1] === request.id && t[3] === "reply"));
  await vi.waitFor(async () => expect(await replies()).toHaveLength(1), { timeout: 6_000 });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("FIRST_HANDOFF");
  expect((await replies())[0].content).toBe("STARTUP_DONE");
  // Another roster update must not replay completed startup work.
  await enroll(true);
  await pause(200);
  expect(prompts).toHaveLength(1);
}, 20_000);
