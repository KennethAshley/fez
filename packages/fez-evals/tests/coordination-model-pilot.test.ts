import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEvent } from "nostr-tools";
import { afterAll, beforeAll, expect, it } from "vitest";
import { previewPilot, runModelPilot, type PilotConfig } from "../../../dev/experiments/coordination/model-pilot.js";
import { KIND_AGENT_TASK } from "../../../src/protocol/kinds.js";
import { repositoryWritablePaths } from "../../../dev/experiments/coordination/repository-tools.js";

const packDirectory = fileURLToPath(new URL("../../../dev/experiments/coordination/", import.meta.url));
const candidate = Buffer.from("Choose a specialist only when their work helps. Deliver the complete result.");
const files = { "task.mjs": "throw new Error('THIS MUST NEVER EXECUTE');", "regression.test.mjs": "throw new Error('DO NOT RUN');", "answer.md": "Draft repair. No code checks have run." };
const model = (id: string) => ({ id, inputMicrousdPerMillion: 1_000_000, outputMicrousdPerMillion: 2_000_000 });
const savedKey = process.env.FEZ_COORDINATION_API_KEY;
beforeAll(() => { process.env.FEZ_COORDINATION_API_KEY = "local-fixture-token"; });
afterAll(() => { if (savedKey === undefined) delete process.env.FEZ_COORDINATION_API_KEY; else process.env.FEZ_COORDINATION_API_KEY = savedKey; });

async function fixture(kind: "normal" | "missing-usage" | "invalid-action" | "loop" | "timeout" | "http-error" | "redirect" | "revision" | "wrong-model" | "truncated" | "oversized-response" | "oversized-usage" | "fenced-json" | "malformed-json" | "reasoning-stop" | "reasoning-length" | "repository") {
  const requests: { model: string; messages: { role: string; content: string }[]; max_tokens: number; response_format?: { type: string }; chat_template_kwargs?: { thinking: boolean } }[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer local-fixture-token") { res.writeHead(401).end(); return; }
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes);
    requests.push(body);
    if (kind === "reasoning-stop" || kind === "reasoning-length") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "chatcmpl-reasoning-only", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: null, reasoning_content: "private-reasoning-sentinel", tool_calls: [], refusal: null },
          finish_reason: kind === "reasoning-stop" ? "stop" : "length" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, reasoning_tokens: 3 } }));
      return;
    }
    if (kind === "timeout") return;
    if (kind === "http-error") { res.writeHead(503).end("private provider diagnostic"); return; }
    if (kind === "redirect") { res.writeHead(302, { Location: "http://127.0.0.1:1/secret" }).end(); return; }
    const context = JSON.parse(body.messages.at(-1).content);
    const delegate = { action: "delegate", specialist: "coder", instruction: "Repair this fixture", files: {} };
    let action: unknown = { action: "submit", files: context.task.startsWith("W") ? { "answer.md": files["answer.md"] } : files };
    if (kind === "invalid-action") action = { action: "submit", files: { "../escape": "unwanted" } };
    else if (kind === "revision" && body.model === "lead" && context.arm === "individual" && context.history.length === 0) action = { action: "revise", instruction: "Review this draft against the sources", files };
    else if (body.model === "lead" && context.arm === "adaptive" && (kind === "loop" || context.history.length === 0)) action = delegate;
    if (kind === "repository") {
      const history = context.toolHistory;
      const path = repositoryWritablePaths[2];
      if (body.model === "lead" && context.arm === "adaptive" && context.history.length === 0 && history.length === 0) action = delegate;
      else if (history.length === 0) action = { action: "tool", request: { name: "read", path } };
      else if (history.length === 1) action = { action: "tool", request: { name: "write", path, sha256: history[0].result.sha256,
        content: history[0].result.content + body.model + "\n" } };
      else action = { action: "submit", files: { "answer.md": "Changed README. No checks run." } };
    }
    const content = kind === "oversized-response" ? "x".repeat(1_048_577) : kind === "fenced-json" ?
      "```json\n" + JSON.stringify(action) + "\n```" : kind === "malformed-json" ? '{"action":' : JSON.stringify(action);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "chatcmpl-local-fixture", object: "chat.completion", created: 1, model: kind === "wrong-model" ? "unexpected-model" : body.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: kind === "truncated" ? "length" : "stop" }],
      ...(kind === "missing-usage" ? {} : { usage: { prompt_tokens: 10, completion_tokens: kind === "oversized-usage" ? 1001 : 3, total_tokens: kind === "oversized-usage" ? 1011 : 13 } }) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  const config: PilotConfig = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, taskId: "C01",
    models: { lead: model("lead"), coder: model("coder"), writer: model("writer"), researcher: model("researcher"), reviewer: model("reviewer") },
    limits: { maxCalls: 6, maxOutputTokens: 1000, maxRequestBytes: 64_000, maxSeconds: kind === "timeout" ? 0.15 : 10 },
  };
  return { config, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it("uses real repository tools in solo and specialist turns, preserving signed delivery and shared costs", async () => {
  const f = await fixture("repository");
  const dir = mkdtempSync(join(tmpdir(), "fez-repository-model-"));
  try {
    const checkouts = { individual: join(dir, "individual"), "fixed-workflow": join(dir, "fixed-workflow"), adaptive: join(dir, "adaptive") };
    for (const checkout of Object.values(checkouts)) {
      for (const path of repositoryWritablePaths) {
        mkdirSync(join(checkout, path, ".."), { recursive: true }); writeFileSync(join(checkout, path), "baseline\n");
      }
      execFileSync("git", ["init", checkout], { stdio: "pipe" });
      execFileSync("git", ["-C", checkout, "add", "."], { stdio: "pipe" });
      execFileSync("git", ["-C", checkout, "-c", "commit.gpgsign=false", "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline"],
        { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-10T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-10T00:00:00Z" } });
    }
    f.config.taskId = "R01"; f.config.limits.maxCalls = 20;
    const preview = await previewPilot(f.config, candidate, packDirectory, checkouts);
    expect(f.requests).toHaveLength(0);
    expect(preview.conditions).toMatchObject({ version: "fez-model-repository-pilot-v1", codeExecution: true, assessment: null });
    const output = join(dir, "run");
    const report = await runModelPilot(output, f.config, candidate, packDirectory, checkouts);
    expect(report.conditionsSha256).toBe(preview.conditionsSha256);
    expect(report.arms.map(arm => arm.status)).toEqual(["delivered", "delivered", "delivered"]);
    expect(report.arms.map(arm => arm.calls.length)).toEqual([3, 12, 7]);
    expect(report.arms.map(arm => arm.costMicrousd)).toEqual([48, 192, 112]);
    const expected = ["baseline\nlead\n", "baseline\ncoder\nwriter\nreviewer\nlead\n", "baseline\ncoder\nlead\n"];
    for (const [index, arm] of report.arms.entries()) {
      expect(readFileSync(join(output, arm.name, "delivered", repositoryWritablePaths[2]), "utf8")).toBe(expected[index]);
      expect(readFileSync(join(output, arm.name, "patch.diff"), "utf8")).toContain("+lead");
      expect(arm.events.every(row => verifyEvent(row.event))).toBe(true);
      const delivered = arm.events.find(row => row.event.id === arm.resultEventId)!;
      expect(JSON.parse(delivered.event.content).result.repositoryHashes).toEqual(Object.fromEntries(repositoryWritablePaths.map(path => [path, arm.artifacts[path]])));
      expect(arm.assessment).toBeNull();
    }
    expect(JSON.stringify(report)).not.toContain("local-fixture-token");
    expect(JSON.stringify(f.requests)).not.toContain("You have no shell, browser, code execution, filesystem access");
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

it("runs matched treatments over HTTP and Fez, preserving artifacts and every call's estimated cost", async () => {
  const f = await fixture("normal");
  const dir = mkdtempSync(join(tmpdir(), "fez-model-pilot-"));
  try {
    const preview = await previewPilot(f.config, candidate, packDirectory);
    expect(f.requests).toHaveLength(0);
    expect(preview.conditions).toMatchObject({ responseFormat: { type: "json_object" } });
    expect(preview.allowance).toEqual({ maximumCalls: 18, maximumRequestedOutputTokens: 18000 });
    const output = join(dir, "run");
    const report = await runModelPilot(output, f.config, candidate, packDirectory);
    expect(report.conditionsSha256).toBe(preview.conditionsSha256);
    expect(report.complete).toBe(true);
    expect(JSON.stringify(report)).not.toContain("local-fixture-token");
    expect(report.arms.map(arm => arm.status)).toEqual(["delivered", "delivered", "delivered"]);
    expect(report.arms.map(arm => arm.calls.map(call => call.role))).toEqual([["lead"], ["coder", "reviewer", "lead"], ["lead", "coder", "lead"]]);
    expect(report.arms.map(arm => arm.costMicrousd)).toEqual([16, 48, 48]);
    expect(report.arms.every(arm => arm.costBasis === "estimated" && arm.assessment === null && arm.checks === null)).toBe(true);
    for (const arm of report.arms) {
      expect(arm.events.every(row => verifyEvent(row.event))).toBe(true);
      expect(readFileSync(join(output, arm.name, "delivered", "task.mjs"), "utf8")).toBe(files["task.mjs"]);
      const tasks = arm.events.filter(row => row.event.kind === KIND_AGENT_TASK).map(row => row.event);
      expect(tasks).toHaveLength(arm.name === "individual" ? 1 : arm.name === "fixed-workflow" ? 3 : 2);
      const root = tasks.find(event => event.pubkey === arm.roster.buyer)!;
      expect(tasks.filter(task => task.id !== root.id).every(task => task.tags.some(t => t[0] === "e" && t[1] === root.id))).toBe(true);
    }
    expect(f.requests.every(request => request.max_tokens === 1000)).toBe(true);
    expect(f.requests.every(request => request.response_format?.type === "json_object")).toBe(true);
    expect(report.arms.flatMap(arm => arm.calls).every(call => "response_format" in call.request)).toBe(true);
    const wireText = JSON.stringify(f.requests);
    expect(wireText).not.toContain("reviewerNotes");
    const pack = JSON.parse(readFileSync(join(packDirectory, "development-pack.json"), "utf8"));
    expect(wireText).not.toContain(JSON.stringify(pack.fixtures.invoice.reference));
    await expect(runModelPilot(output, f.config, candidate, packDirectory)).rejects.toThrow(/exist/i);
    expect(f.requests).toHaveLength(7);
    expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(report)));
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);

it.each(["missing-usage", "invalid-action", "loop", "timeout", "http-error", "redirect", "wrong-model", "truncated", "oversized-response", "oversized-usage", "fenced-json", "malformed-json"] as const)("retains honest evidence for %s", async kind => {
  const f = await fixture(kind);
  const dir = mkdtempSync(join(tmpdir(), "fez-model-failure-"));
  try {
    const output = join(dir, "run");
    const report = await runModelPilot(output, f.config, candidate, packDirectory);
    expect(report.arms).toHaveLength(3);
    expect(report.arms.every(arm => arm.assessment === null && arm.calls.length <= 6)).toBe(true);
    if (kind === "missing-usage") expect(report.arms.every(arm => arm.costMicrousd === null && arm.costBasis === "unknown")).toBe(true);
    else if (kind === "loop") {
      expect(report.arms[2].status).toBe("failed");
      expect(report.arms[2].calls).toHaveLength(6);
      expect(report.arms[2].error).toMatch(/call limit/i);
    } else {
      expect(report.arms.every(arm => arm.status === "failed")).toBe(true);
      expect(existsSync(join(dir, "escape"))).toBe(false);
      expect(report.arms.every(arm => Object.keys(arm.artifacts).length === 0)).toBe(true);
      expect(JSON.stringify(report)).not.toContain("private provider diagnostic");
      if (["fenced-json", "malformed-json"].includes(kind)) {
        expect(report.arms.every(arm => arm.error === "model answer is not valid JSON" && arm.costMicrousd === 16)).toBe(true);
        expect(report.arms.every(arm => arm.calls[0].text?.startsWith(kind === "fenced-json" ? "```json\n" : '{"action":'))).toBe(true);
      } else if (!["invalid-action", "truncated", "oversized-usage"].includes(kind)) expect(report.arms.every(arm => arm.costMicrousd === null)).toBe(true);
    }
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);

it("refuses invalid configuration before contacting the endpoint", async () => {
  const f = await fixture("normal");
  try {
    for (const change of [{ baseUrl: "http://example.com/v1" }, { baseUrl: "https://user:password@example.com/v1" },
      { baseUrl: "https://example.com/v1?key=secret" }, { limits: { ...f.config.limits, maxCalls: 0 } }, { taskId: "unknown" }]) {
      await expect(previewPilot({ ...f.config, ...change }, candidate, packDirectory)).rejects.toThrow();
    }
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});

it("allows the individual to revise its own work within the same allowance", async () => {
  const f = await fixture("revision");
  const dir = mkdtempSync(join(tmpdir(), "fez-model-revision-"));
  try {
    const report = await runModelPilot(join(dir, "run"), f.config, candidate, packDirectory);
    expect(report.arms[0].status).toBe("delivered");
    expect(report.arms[0].calls.map(call => call.role)).toEqual(["lead", "lead"]);
    expect(report.arms[0].costMicrousd).toBe(32);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("rejects oversized requests before sending or recording a billable call", async () => {
  const f = await fixture("normal");
  const dir = mkdtempSync(join(tmpdir(), "fez-model-request-cap-"));
  try {
    f.config.limits.maxRequestBytes = 1024;
    const report = await runModelPilot(join(dir, "run"), f.config, candidate, packDirectory);
    expect(f.requests).toHaveLength(0);
    expect(report.arms.every(arm => arm.status === "failed" && arm.calls.length === 0 && arm.costMicrousd === null)).toBe(true);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["W01", "X01"])("uses the appropriate fixed specialist sequence for %s", async taskId => {
  const f = await fixture("normal");
  const dir = mkdtempSync(join(tmpdir(), "fez-model-family-"));
  try {
    const report = await runModelPilot(join(dir, "run"), { ...f.config, taskId }, candidate, packDirectory);
    expect(report.arms.every(arm => arm.status === "delivered")).toBe(true);
    expect(report.arms[1].calls.map(call => call.role)).toEqual(taskId === "W01" ? ["researcher", "writer", "reviewer", "lead"] : ["coder", "writer", "reviewer", "lead"]);
    expect(Object.keys(report.arms[1].artifacts).sort()).toEqual(taskId === "W01" ? ["answer.md"] : ["answer.md", "regression.test.mjs", "task.mjs"]);
    for (const request of f.requests) {
      const actions = [...request.messages[0].content.matchAll(/"action":"(\w+)"/g)].map(match => match[1]);
      const context = JSON.parse(request.messages[1].content);
      expect(actions).toEqual(request.model !== "lead" ? ["submit"] : context.arm === "adaptive" ? ["submit", "revise", "delegate"] : ["submit", "revise"]);
    }
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("freezes per-model thinking settings and sends them only to the selected model", async () => {
  const f = await fixture("normal");
  const dir = mkdtempSync(join(tmpdir(), "fez-model-thinking-"));
  try {
    const config = { ...f.config, taskId: "X01", models: { ...f.config.models, writer: { ...f.config.models.writer, thinking: false } } };
    const preview = await previewPilot(config, candidate, packDirectory);
    const defaults = await previewPilot({ ...f.config, taskId: "X01" }, candidate, packDirectory);
    expect(preview.conditionsSha256).not.toBe(defaults.conditionsSha256);
    expect(preview.conditions.config.models.writer).toMatchObject({ thinking: false });
    const enabled = await previewPilot({ ...config, models: { ...config.models, writer: { ...config.models.writer, thinking: true } } }, candidate, packDirectory);
    expect(enabled.conditionsSha256).not.toBe(preview.conditionsSha256);
    const report = await runModelPilot(join(dir, "run"), config, candidate, packDirectory);
    expect(report.arms.every(arm => arm.status === "delivered")).toBe(true);
    expect(f.requests.find(request => request.model === "writer")?.chat_template_kwargs).toEqual({ thinking: false });
    expect(f.requests.filter(request => request.model !== "writer").every(request => !("chat_template_kwargs" in request))).toBe(true);
    expect(report.conditionsSha256).toBe(preview.conditionsSha256);
    for (const thinking of [null, "false", 0, {}]) {
      await expect(previewPilot(JSON.parse(JSON.stringify({ ...config, models: { ...config.models, writer: { ...config.models.writer, thinking } } })), candidate, packDirectory)).rejects.toThrow(/thinking/);
    }
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["reasoning-stop", "reasoning-length"] as const)("keeps stop and usage evidence for %s without retaining private reasoning", async kind => {
  const f = await fixture(kind);
  const dir = mkdtempSync(join(tmpdir(), "fez-model-reasoning-"));
  try {
    const report = await runModelPilot(join(dir, "run"), f.config, candidate, packDirectory);
    for (const arm of report.arms) {
      expect(arm.status).toBe("failed");
      expect(arm.error).toBe("missing model answer");
      expect(arm.artifacts).toEqual({});
      expect(arm.calls[0]).toMatchObject({ finishReason: kind === "reasoning-stop" ? "stop" : "length", reasoningTokens: 3, text: null, costMicrousd: 16 });
    }
    expect(JSON.stringify(report)).not.toContain("private-reasoning-sentinel");
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});
