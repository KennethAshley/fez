import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { startAcpRuntime, TEST_CHANNEL } from "./helpers/acp-runtime.js";

let runtime: Awaited<ReturnType<typeof startAcpRuntime>> | undefined;
afterEach(async () => { await runtime?.stop(); runtime = undefined; });

const reported = (r: NonNullable<typeof runtime>, requestId: string, reply: string) => r.relay.events.filter(e =>
  e.pubkey === r.agentPk && e.content.includes(reply) &&
  e.tags.some(t => t[0] === "result" && t[1] === requestId) && e.tags.some(t => t[0] === "status" && t[1] === "error"));


it("reports interrupted work, recovers every queued assignment, and does not redeliver after another restart", async () => {
  const r = runtime = await startAcpRuntime("queue");
  const tags = [["h", TEST_CHANNEL], ["p", r.agentPk], ["task", r.agentPk]];
  const first = await r.send("FIRST durable job", tags);
  await r.wait(() => r.prompts.length === 1, "first running");
  const second = await r.send("SECOND durable job", tags);
  const third = await r.send("THIRD durable job", tags);
  await r.wait(() => r.output.includes(third.id.slice(0, 8)), "third saved");
  await r.restart();
  await r.wait(() => r.relay.events.some(e => e.tags.some(t => t[0] === "result" && t[1] === first.id)), "interruption reported");
  const interrupted = r.relay.events.find(e => e.tags.some(t => t[0] === "result" && t[1] === first.id))!;
  expect(interrupted.tags).toContainEqual(["status", "error"]);
  expect(interrupted.content).toMatch(/interrupted/i);
  await r.wait(() => r.prompts.length === 2, "second recovered");
  expect(r.prompts[1].instruction).toContain(second.id);
  r.release(r.prompts[1], "SECOND done");
  await r.wait(() => r.prompts.length === 3, "third recovered separately");
  expect(r.prompts[2].instruction).toContain(third.id);
  r.release(r.prompts[2], "THIRD done");
  await r.wait(() => reported(r, third.id, "THIRD done").length === 1, "last reply published");
  await r.restart();
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect(r.prompts).toHaveLength(3);
  expect(reported(r, second.id, "SECOND done")).toHaveLength(1);
}, 45000);

it("reviews only one result per assigned worker even when two signed result IDs arrive", async () => {
  const r = runtime = await startAcpRuntime("queue");
  const key = Buffer.from(await fs.readFile(path.join(r.testHome, ".fez/agents/scope-test.key"), "utf8"), "hex");
  const request = finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000), content: "delegate",
    tags: [["h", TEST_CHANNEL], ["task", r.owner.getPubkey()], ["p", r.owner.getPubkey()]] }, key);
  await r.publish(request);
  for (let i = 0; i < 2; i++) await r.publish(r.owner.signEvent({ kind: 47103, content: `result ${i}`, tags: [
    ["h", TEST_CHANNEL], ["result", request.id], ["status", "success"], ["p", r.agentPk],
    ["e", request.id, "", "root"], ["e", request.id, "", "reply"],
  ] }));
  await r.wait(() => r.prompts.length === 1, "result review started");
  r.release(r.prompts[0], "reviewed");
  await r.wait(() => r.relay.events.some(event => event.content === "reviewed"), "review published");
  await r.restart();
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect(r.prompts).toHaveLength(1);
}, 45000);

it("keeps accepted overflow on disk and rechecks permissions after restart", async () => {
  const r = runtime = await startAcpRuntime("queue");
  const tags = [["h", TEST_CHANNEL], ["p", r.agentPk], ["task", r.agentPk]];
  const peerKey = generateSecretKey(), peerPk = getPublicKey(peerKey);
  const now = Math.floor(Date.now() / 1000);
  await r.publish(r.owner.signEvent({ kind: 47006, content: "", tags: [["p", peerPk]] }));
  await r.publish(r.owner.signEvent({ kind: 47102, created_at: now + 1, content: "", tags: [["d", "roster"],
    ["p", r.owner.getPubkey(), "owner"], ["p", r.agentPk, "bot"], ["p", peerPk, "bot"]] }));
  const send = async (content: string) => {
    const event = finalizeEvent({ kind: 47103, content, tags, created_at: now }, peerKey);
    await r.publish(event); return event;
  };
  await send("blocking job");
  await r.wait(() => r.prompts.length === 1, "blocking job running");
  const jobs = [];
  for (let i = 0; i < 22; i++) jobs.push(await send(`overflow ${i}`));
  const root = path.join(r.testHome, ".fez/agents/inbox");
  const [scope] = await fs.readdir(root);
  const file = path.join(root, scope, "inbox.json");
  let state = JSON.parse(await fs.readFile(file, "utf8"));
  for (let i = 0; i < 50 && Object.keys(state.items).length !== 23; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    state = JSON.parse(await fs.readFile(file, "utf8"));
  }
  expect(Object.keys(state.items)).toHaveLength(23);
  await r.restart(async () => {
    // Revoke the sender's workspace membership while the agent is down.
    await r.publish(r.owner.signEvent({ kind: 47102, content: "", created_at: Math.floor(Date.now() / 1000) + 2,
      tags: [["d", "roster"], ["p", r.owner.getPubkey(), "owner"], ["p", r.agentPk, "bot"]] }));
  });
  await r.wait(() => r.output.includes("revoked by current permissions"), "pending work rechecked");
  expect(r.prompts).toHaveLength(1);
  state = JSON.parse(await fs.readFile(file, "utf8"));
  expect(jobs.every(job => state.items[job.id].state === "finished")).toBe(true);
}, 45000);

it("recovers assignments older than two minutes from the saved channel checkpoint", async () => {
  const r = runtime = await startAcpRuntime("queue");
  const root = path.join(r.testHome, ".fez/agents/inbox");
  const [scope] = await fs.readdir(root);
  const file = path.join(root, scope, "inbox.json");
  const ids: string[] = [];
  await r.restart(async () => {
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.cursors[TEST_CHANNEL] = Math.floor(Date.now() / 1000) - 600;
    await fs.writeFile(file, JSON.stringify(state));
    for (let i = 0; i < 2; i++) {
      const event = r.owner.signEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000) - 300,
        content: `offline ${i}`, tags: [["h", TEST_CHANNEL], ["p", r.agentPk], ["task", r.agentPk]] });
      ids.push(event.id); await r.publish(event);
    }
  });
  await r.wait(() => r.prompts.length === 1, "first offline job recovered");
  r.release(r.prompts[0], "offline done");
  await r.wait(() => r.prompts.length === 2, "second offline job recovered");
  expect(ids.every(id => r.prompts.some(prompt => prompt.instruction.includes(id)))).toBe(true);
  r.release(r.prompts[1]);
}, 45000);


it("gates disk-loaded queued work during and after failed reconciliation without holding new work", async () => {
  const r = runtime = await startAcpRuntime("queue");
  const tags = [["h", TEST_CHANNEL], ["p", r.agentPk], ["task", r.agentPk]];
  const old = await r.send("OLD completed assignment", tags);
  await r.wait(() => r.prompts.length === 1, "old started");
  r.release(r.prompts[0], "already completed");
  await r.wait(() => reported(r, old.id, "already completed").length === 1, "old reply");
  let rejectHistory!: (error: Error) => void;
  let reconciling = false;
  const held = new Promise<void>((_, reject) => { rejectHistory = reject; });
  const restarting = r.restart(async () => {
    const root = path.join(r.testHome, ".fez/agents/inbox");
    const [scope] = await fs.readdir(root), file = path.join(root, scope, "inbox.json");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.items[old.id].state = "queued";
    await fs.writeFile(file, JSON.stringify(state));
    r.relay.beforeHistory = async filters => {
      if (filters.some(f => f.authors?.includes(r.agentPk) && f["#e"]?.includes(old.id))) {
        reconciling = true; await held;
      }
    };
  });
  await r.wait(() => reconciling, "checked reconciliation suspended");
  await r.publish(old);
  await r.send("@scope-test NEW unrelated work");
  await r.wait(() => r.prompts.length === 2, "new work runs while history waits");
  rejectHistory(new Error("offline"));
  await restarting;
  expect(r.prompts[1].instruction).toContain("NEW unrelated work");
  await r.wait(() => r.output.includes("Pending work recovery will retry"), "failed reconciliation");
  r.release(r.prompts[1], "new work finished");
  await r.wait(() => r.relay.events.some(e => e.content === "new work finished"), "unrelated turn drained");
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(r.prompts).toHaveLength(2);
}, 45000);

it("counts durable failures and result-review failures toward the breaker, excluding owner cancellation", async () => {
  const r = runtime = await startAcpRuntime("queue");
  const tags = [["h", TEST_CHANNEL], ["p", r.agentPk], ["task", r.agentPk]];
  await r.send("cancelled job", tags);
  await r.wait(() => r.prompts.length === 1, "cancelled job started");
  await r.cancel();
  await r.wait(() => r.aborted.length === 1, "owner cancellation received");
  r.release(r.prompts[0]);
  await r.wait(() => r.relay.events.some(e => e.content.includes("stopped by my owner")), "cancellation delivered");
  for (let i = 0; i < 2; i++) {
    await r.send(`failing task ${i}`, tags);
    await r.wait(() => r.prompts.length === i + 2, "failing task started");
    r.release(r.prompts[i + 1], "", "invalid API key");
    await r.wait(() => r.relay.events.filter(e => e.content.includes("invalid API key")).length === i + 1, "failure delivered");
  }
  const key = Buffer.from(await fs.readFile(path.join(r.testHome, ".fez/agents/scope-test.key"), "utf8"), "hex");
  const request = finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000), content: "delegated task",
    tags: [["h", TEST_CHANNEL], ["task", r.owner.getPubkey()], ["p", r.owner.getPubkey()]] }, key);
  await r.publish(request);
  await r.send("result to review", [["h", TEST_CHANNEL], ["result", request.id], ["status", "success"], ["p", r.agentPk],
    ["e", request.id, "", "root"], ["e", request.id, "", "reply"]]);
  await r.wait(() => r.prompts.length === 4, "result review started before breaker");
  r.release(r.prompts[3], "", "invalid API key");
  await r.wait(() => r.relay.events.filter(e => e.content.includes("invalid API key")).length === 3, "third failure delivered");
  expect(r.output).toContain("Breaker tripped");
  const waiting = await r.send("wait through cooldown", tags);
  await r.wait(() => r.output.includes("Breaker open"), "cooldown admission");
  const root = path.join(r.testHome, ".fez/agents/inbox"), [scope] = await fs.readdir(root);
  const state = JSON.parse(await fs.readFile(path.join(root, scope, "inbox.json"), "utf8"));
  expect(state.items[waiting.id].state).toBe("queued");
  expect(r.prompts).toHaveLength(4);
}, 45000);


it("receives late published assignments live and recovers today's old timestamp after restart", async () => {
  const r = runtime = await startAcpRuntime("queue");
  const late = (content: string) => r.owner.signEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000) - 50 * 3600,
    content, tags: [["h", TEST_CHANNEL], ["p", r.agentPk], ["task", r.agentPk]] });
  const live = late("late live assignment");
  await r.publish(live);
  await r.wait(() => r.prompts.length === 1, "old timestamp delivered live");
  expect(r.prompts[0].instruction).toContain(live.id);
  r.release(r.prompts[0], "late live done");
  await r.wait(() => reported(r, live.id, "late live done").length === 1, "late live finished");
  const offline = late("late offline assignment");
  await r.restart(async () => { await r.publish(offline); });
  await r.wait(() => r.prompts.length === 2, "old timestamp recovered behind current checkpoint");
  expect(r.prompts[1].instruction).toContain(offline.id);
  r.release(r.prompts[1], "late offline done");
  await r.wait(() => reported(r, offline.id, "late offline done").length === 1, "late offline finished");
}, 45000);
