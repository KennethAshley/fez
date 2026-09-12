import { afterEach, expect, it } from "vitest";
import { startAcpRuntime, TEST_CHANNEL } from "./helpers/acp-runtime.js";

let runtime: Awaited<ReturnType<typeof startAcpRuntime>> | undefined;
afterEach(async () => { await runtime?.stop(); runtime = undefined; });
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
const configured = "reflectionEvery: 1m\nreflectionPrompt: Keep the documentation accurate.";
function metrics(r: Awaited<ReturnType<typeof startAcpRuntime>>) {
  return r.relay.events.filter(event => event.kind === 47030).map(event =>
    JSON.parse(r.owner.decryptFrom(r.agentPk, event.content)) as { scope: string; status: string; replyChars: number; usage?: { costUsd?: number } });
}

it("does not start reflection without an interval", async () => {
  const r = runtime = await startAcpRuntime("steer", { manualIntervalMs: 60_000 });
  await pause(2700); // Let the real 2.5s DM startup replay window close.
  await r.tick(); await pause();
  expect(r.prompts).toHaveLength(0);
}, 35_000);

it("reflects privately, skips busy ticks, and drains messages before another reflection", async () => {
  const r = runtime = await startAcpRuntime("steer", { frontmatter: configured, manualIntervalMs: 60_000 });
  expect(r.prompts).toHaveLength(0); // no immediate startup inference
  await pause(2700);
  await r.tick();
  await r.wait(() => r.prompts.length === 1, "first reflection");
  const first = r.prompts[0];
  expect(first.instruction).toContain("Keep the documentation accurate.");
  expect(first.instruction).toContain(TEST_CHANNEL);
  await r.tick(); await pause();
  expect(r.prompts).toHaveLength(1);
  await r.send("@scope-test Answer this actual request.");
  await r.wait(() => r.output.includes("queued for"), "message queued behind reflection");
  r.release(first, "NO_ACTION");
  await r.wait(() => r.prompts.length === 2, "queued message");
  expect(r.prompts[1].instruction).toContain("Answer this actual request.");
  expect(r.prompts[1].session).not.toBe(first.session);
  await r.tick(); await pause();
  expect(r.prompts).toHaveLength(2);
  r.release(r.prompts[1], "Request answered.");
  await r.wait(() => metrics(r).length === 2, "finished turns");
  expect(metrics(r)[0]).toMatchObject({ scope: "reflection", status: "done", replyChars: 0 });
  expect(r.relay.events.filter(e => e.pubkey === r.agentPk && e.kind === 47103).map(e => e.content)).toEqual(["Request answered."]);
  expect(r.relay.events.filter(e => e.kind === 1059)).toHaveLength(0);
  await r.tick();
  await r.wait(() => r.prompts.length === 3, "next reflection");
  expect(r.prompts[2].session).toBe(first.session);
  r.release(r.prompts[2], "NO_ACTION");
  await r.wait(() => metrics(r).length === 3, "reflection finished");
}, 35_000);

it("accepts an empty no-op and shares the hourly turn budget", async () => {
  const r = runtime = await startAcpRuntime("steer", { frontmatter: configured, manualIntervalMs: 60_000,
    env: { FEZ_AGENT_MAX_TURNS_PER_HOUR: "1" } });
  await pause(2700);
  await r.tick();
  await r.wait(() => r.prompts.length === 1, "reflection");
  r.release(r.prompts[0], "");
  await r.wait(() => metrics(r).length === 1, "empty reflection finished");
  expect(metrics(r)[0]).toMatchObject({ scope: "reflection", status: "done", replyChars: 0 });
  await r.tick(); await pause();
  expect(r.prompts).toHaveLength(1);
}, 35_000);

it("accounts reflection usage against the daily spend cap", async () => {
  const r = runtime = await startAcpRuntime("steer", { frontmatter: `${configured}\nspendCapUsd: 0.01`, manualIntervalMs: 60_000 });
  await pause(2700);
  await r.tick();
  await r.wait(() => r.prompts.length === 1, "reflection");
  r.release(r.prompts[0], "NO_ACTION", undefined, 0.02);
  await r.wait(() => metrics(r).length === 1, "metered reflection");
  expect(metrics(r)[0].usage?.costUsd).toBe(0.02);
  await r.tick(); await pause();
  expect(r.prompts).toHaveLength(1);
}, 35_000);

it("honors owner cancellation without replaying reflection", async () => {
  const r = runtime = await startAcpRuntime("steer", { frontmatter: configured, manualIntervalMs: 60_000 });
  await pause(2700);
  await r.tick();
  await r.wait(() => r.prompts.length === 1, "reflection");
  const first = r.prompts[0];
  await r.cancel();
  await r.wait(() => r.aborted.includes(first.id), "reflection cancelled");
  r.release(first);
  await r.wait(() => metrics(r).length === 1, "cancel metric");
  expect(metrics(r)[0]).toMatchObject({ scope: "reflection", status: "cancelled" });
  await pause();
  expect(r.prompts).toHaveLength(1);
}, 35_000);

it("does not replay a failed reflection and pauses after repeated failures", async () => {
  const r = runtime = await startAcpRuntime("steer", { frontmatter: configured, manualIntervalMs: 60_000 });
  await pause(2700);
  for (let i = 0; i < 3; i++) {
    await r.tick();
    await r.wait(() => r.prompts.length === i + 1, "reflection");
    r.release(r.prompts[i], "", "connection reset");
    await r.wait(() => metrics(r).length === i + 1, "failure metric");
    expect(metrics(r)[i].status).toBe("failed");
  }
  await r.tick(); await pause();
  expect(r.prompts).toHaveLength(3);
}, 35_000);

it("delivers final observer text and rotates reflection without an extra handoff turn", async () => {
  const r = runtime = await startAcpRuntime("steer", { frontmatter: configured, manualIntervalMs: 60_000,
    env: { FEZ_SESSION_TURN_CAP: "1" } });
  await pause(2700);
  await r.tick();
  await r.wait(() => r.prompts.length === 1, "reflection");
  r.release(r.prompts[0], "Updated README.", undefined, undefined, "Checking docs...");
  await r.wait(() => metrics(r).length === 1, "reflection completed");
  const frames = r.relay.events.filter(e => e.kind === 20004).map(e => JSON.parse(r.owner.decryptFrom(r.agentPk, e.content)));
  expect(frames.some(frame => frame.type === "text" && frame.text === "Updated README.")).toBe(true);
  await r.tick();
  await r.wait(() => r.prompts.length === 2, "next reflection");
  expect(r.prompts[1].instruction).toContain("Keep the documentation accurate.");
  expect(r.prompts[1].session).not.toBe(r.prompts[0].session);
  r.release(r.prompts[1], "NO_ACTION");
  await r.wait(() => metrics(r).length === 2, "second reflection completed");
}, 35_000);

it("waits for in-flight work recovery and respects membership revocation", async () => {
  const r = runtime = await startAcpRuntime("steer", { frontmatter: configured, manualIntervalMs: [60_000, 30_000] });
  await pause(2700);
  let reading = false;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  r.relay.beforeHistory = async filters => {
    if (filters.some(filter => filter["#task"])) { reading = true; await blocked; }
  };
  try {
    await r.tick(30_000);
    await r.wait(() => reading, "recovery history read");
    await r.tick(); await pause();
    expect(r.prompts).toHaveLength(0);
  } finally { release(); r.relay.beforeHistory = undefined; }
  const priorRoster = r.relay.events.find(e => e.kind === 47102)!;
  await r.publish(r.owner.signEvent({ kind: 47102, created_at: priorRoster.created_at + 1,
    tags: [["d", "roster"], ["p", r.owner.getPubkey(), "owner"]], content: "" }));
  await pause();
  await r.tick(); await pause();
  expect(r.prompts).toHaveLength(0);
}, 35_000);
