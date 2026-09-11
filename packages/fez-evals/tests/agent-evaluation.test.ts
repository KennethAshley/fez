import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, Persona } from "@fezchat/protocol";
import { evaluationReady, evaluationRuntime, assertEvaluationToolsUnchanged, parseEvaluationRequest, runEvaluation } from "../../fez-acp/src/evaluation.js";

const persona: Persona = {
  id: "writer", harness: "controlled", aliases: [], systemPrompt: "Keep the owner's voice.",
  mcpServers: ["reader"], mcpSources: {}, skills: ["style"], skillSources: {}, skillSettings: {},
  extra: { provider: "owner-provider", model: "owner-model", workdir: "/private/work", repo: "private-repo" }, createdAt: "2026-09-10",
};
const harness: HarnessAdapter = { id: "controlled", command: "controlled", aliases: [], detect: async () => true, invoke: async () => "done" };
const ready = () => evaluationReady({ persona, harness, tools: ["reader", "fez"], skills: ["style"], missingTools: [], configuration: { apiKey: "PRIVATE_CREDENTIAL" } });
const request = { prompt: "Write the public script.", maxCostUsd: 0.1, timeoutMs: 1000 };
afterEach(() => vi.restoreAllMocks());

it("rejects missing allowances, malformed requests, and configuration changes before invoking an engine", async () => {
  for (const value of [{ prompt: "work" }, { ...request, maxCostUsd: 0 }, { ...request, timeoutMs: Infinity }, { ...request, prompt: " " }, { ...request, configHash: "bad" }, { ...request, mcpServers: ["new-tool"] }]) {
    expect(() => parseEvaluationRequest(value)).toThrow();
  }
  const invoke = vi.fn(harness.invoke);
  await expect(runEvaluation({ request: { ...request, configHash: "a".repeat(64) }, ready: ready(), harness: { ...harness, invoke }, mcpServers: [], systemPrompt: "private persona" })).rejects.toThrow("configuration changed");
  expect(invoke).not.toHaveBeenCalled();
});

it("identifies the actual configured persona and capabilities without publishing private configuration", () => {
  const record = ready();
  expect(record).toMatchObject({ ready: true, persona: "writer", harness: "controlled", provider: "owner-provider", model: "owner-model", tools: ["fez", "reader"], skills: ["style"] });
  expect(JSON.stringify(record)).not.toMatch(/PRIVATE_CREDENTIAL|private-repo|private\/work|owner's voice/);
  expect(evaluationReady({ persona: { ...persona, systemPrompt: "Changed" }, harness, tools: record.tools, skills: record.skills, missingTools: [], configuration: { apiKey: "PRIVATE_CREDENTIAL" } }).configHash).not.toBe(record.configHash);
  expect(evaluationReady({ persona, harness, tools: [], skills: [], missingTools: ["reader"], configuration: {} }).ready).toBe(false);
});

it("uses a fresh directory and the selected instructions/tools, retaining unknown cost instead of reporting free work", async () => {
  let directory = "";
  const invoke: HarnessAdapter["invoke"] = async (prompt, cwd, _progress, tools) => {
    directory = cwd!;
    expect(directory).not.toBe(persona.extra.workdir);
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(prompt).toContain("Keep the owner's voice.");
    expect(prompt).toContain("[Skills] style");
    expect(prompt).toContain(request.prompt);
    expect(prompt).not.toContain("private-repo");
    expect(tools?.map(t => t.name)).toEqual(["reader"]);
    return "The script.";
  };
  const result = await runEvaluation({ request, ready: ready(), harness: { ...harness, invoke }, mcpServers: [{ name: "reader", command: "reader", args: [], env: [] }], systemPrompt: persona.systemPrompt, skillsSection: "[Skills] style" });
  expect(result).toMatchObject({ text: "The script.", costUsd: null, inputTokens: null, outputTokens: null, withinLimits: null });
  expect(fs.existsSync(directory)).toBe(false);
});

it("records observed usage and aborts at a declared allowance without retrying", async () => {
  const measured: HarnessAdapter["invoke"] = async (_prompt, _cwd, _progress, _tools, update) => {
    update?.({ type: "usage", inputTokens: 10, outputTokens: 4, costUsd: 0.02 });
    return "done";
  };
  expect(await runEvaluation({ request, ready: ready(), harness: { ...harness, invoke: measured }, mcpServers: [] })).toMatchObject({ costUsd: 0.02, inputTokens: 10, outputTokens: 4, withinLimits: true });
  const over = vi.fn<HarnessAdapter["invoke"]>(async (_prompt, _cwd, _progress, _tools, update, signal) => {
    update?.({ type: "usage", costUsd: 0.11 });
    expect(signal?.aborted).toBe(true);
    return "over allowance";
  });
  await expect(runEvaluation({ request, ready: ready(), harness: { ...harness, invoke: over }, mcpServers: [] })).rejects.toThrow("allowance");
  expect(over).toHaveBeenCalledTimes(1);
});

it("aborts timed out work even when an engine fails to stop promptly", async () => {
  let signal: AbortSignal | undefined;
  const invoke: HarnessAdapter["invoke"] = async (_prompt, _cwd, _progress, _tools, _update, got) => { signal = got; return new Promise(() => {}); };
  await expect(runEvaluation({ request: { ...request, timeoutMs: 10 }, ready: ready(), harness: { ...harness, invoke }, mcpServers: [] })).rejects.toThrow("deadline");
  expect(signal?.aborted).toBe(true);
});

it("preserves the cost of failed model work without exposing raw provider errors", async () => {
  const invoke: HarnessAdapter["invoke"] = async (_prompt, _cwd, _progress, _tools, update) => {
    update?.({ type: "usage", inputTokens: 15, costUsd: 0.025 });
    throw new Error("Provider rejected PRIVATE_CREDENTIAL");
  };
  await expect(runEvaluation({ request, ready: ready(), harness: { ...harness, invoke }, mcpServers: [] })).rejects.toMatchObject({
    message: "Agent evaluation failed before delivery", observation: { inputTokens: 15, outputTokens: null, costUsd: 0.025, withinLimits: true },
  });
});

it("reads effective Pi defaults and credential presence without executing or exposing secrets, and detects default drift", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fez-pi-readiness-"));
  const agent = path.join(directory, ".pi/agent"), binary = path.join(directory, ".fez/bin/pi");
  fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "must not execute", { mode: 0o755 });
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "owner-default" }));
  const configured = { ...persona, harness: "pi", extra: {} };
  const runtime = () => evaluationRuntime({ persona: configured, home: directory, env: {} });
  try {
    expect(runtime()).toMatchObject({ provider: "openai", model: "owner-default", missing: ["provider credentials"] });
    fs.writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "PRIVATE_CREDENTIAL" } }));
    const first = runtime();
    expect(first.missing).toEqual([]);
    const firstRecord = evaluationReady({ persona: configured, harness, tools: [], skills: [], missingTools: [], configuration: {}, runtime: first });
    expect(firstRecord).toMatchObject({ provider: "openai", model: "owner-default" });
    expect(JSON.stringify(firstRecord)).not.toContain("PRIVATE_CREDENTIAL");
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "changed-default" }));
    expect(evaluationReady({ persona: configured, harness, tools: [], skills: [], missingTools: [], configuration: {}, runtime: runtime() }).configHash).not.toBe(firstRecord.configHash);
    fs.unlinkSync(binary);
    expect(runtime().missing).toContain("pi executable");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it("fails closed when credential commands or unresolved environment values would require an active probe", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fez-pi-credentials-"));
  const agent = path.join(directory, ".pi/agent"); fs.mkdirSync(agent, { recursive: true });
  const configured = { ...persona, harness: "pi", extra: { provider: "openai", model: "selected" } };
  try {
    for (const key of ["!touch must-not-run", "$MISSING_KEY"]) {
      fs.writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key } }));
      expect(evaluationRuntime({ persona: configured, home: directory, env: {} }).missing).toContain("provider credentials");
    }
    fs.writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: "stored", refresh: "refresh", expires: Date.now() + 1000 } }));
    expect(evaluationRuntime({ persona: configured, home: directory, env: {} }).missing).not.toContain("provider credentials");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it("rejects OAuth refresh dropping or replacing an enabled tool", () => {
  const tools = [{ name: "reader", type: "http" as const, url: "https://tool.example/mcp", headers: [] }];
  expect(() => assertEvaluationToolsUnchanged(tools, [])).toThrow("enabled tools changed");
  expect(() => assertEvaluationToolsUnchanged(tools, [{ ...tools[0], url: "https://other.example/mcp" }])).toThrow("enabled tools changed");
  expect(() => assertEvaluationToolsUnchanged(tools, [{ ...tools[0], headers: [{ name: "Authorization", value: "Bearer FRESH" }] }])).not.toThrow();
});


it("does not claim a funded completion when native metering became unavailable", async () => {
  const measured: HarnessAdapter["invoke"] = async (_prompt, _dir, _progress, _tools, update) => {
    update?.({ type: "usage", costUsd: 0.02 });
    update?.({ type: "usage", metering: "unavailable" });
    return "The script.";
  };
  expect(await runEvaluation({ request, ready: ready(), harness: { ...harness, invoke: measured }, mcpServers: [] }))
    .toMatchObject({ costUsd: 0.02, withinLimits: null });
});
