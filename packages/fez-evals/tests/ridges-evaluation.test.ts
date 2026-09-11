import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import type { SubmissionContext } from "../../fez-extension-api/src/miner.js";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: inspect }) };
});
import ridges from "../../fez-ridges/src/miner.js";
import { evaluateRidges, EVALUATION_BRIDGE, REVIEWED_RIDGES_COMMIT, type EvaluationProcess } from "../../fez-ridges/src/evaluation.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const output = { dataset: `sha256:${"a".repeat(64)}`, reward: 0.75, passed: 3, failed: 1, skipped: 0 };
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ridges-evaluation-"))); dirs.push(dir);
  const checkout = join(dir, "checkout");
  const task = join(dir, "task");
  const candidate = join(dir, "candidate.py");
  await mkdir(checkout); await mkdir(join(task, "environment"), { recursive: true });
  await writeFile(join(task, "instruction.md"), "Fix this task");
  await writeFile(join(task, "task.toml"), 'version = "1.0"');
  await writeFile(candidate, 'raise RuntimeError("candidate must never execute on the host")\n');
  const ctx: SubmissionContext = { persona: "coder", walletBin: "/unused", workDir: dir, config: {
    evaluation_checkout: checkout, evaluation_commit: REVIEWED_RIDGES_COMMIT, evaluation_task: task,
    evaluation_python: join(checkout, ".venv/bin/python"),
    openrouter_api_key: "runtime-secret", openrouter_management_key: "management-secret", ticket: "ticket-secret",
  } };
  inspect.mockImplementation(async (_command, args: string[]) => ({ stdout:
    args.includes("--show-toplevel") ? checkout : args.includes("HEAD") ? ctx.config.evaluation_commit : "" }));
  const execute = vi.fn<EvaluationProcess>().mockResolvedValue(JSON.stringify(output));
  return { ctx, checkout, task, candidate, execute };
}

it("exposes explicit evaluation with concise setup, relaxed-mode labeling and no syntax score", () => {
  expect(ridges[0].development?.evaluate).toBe(evaluateRidges);
  const instructions = ridges[0].development!.instructions;
  expect(instructions.split(/\s+/).length).toBeLessThanOrEqual(150);
  expect(instructions).toContain("explicit request");
  expect(instructions).toContain("syntax only");
  expect(instructions).toContain("relaxes production restrictions");
  expect(ridges[0].config?.filter(f => f.key.startsWith("evaluation_")).map(f => f.key)).toEqual([
    "evaluation_checkout", "evaluation_commit", "evaluation_python", "evaluation_task",
  ]);
  expect(inspect).not.toHaveBeenCalled();
});

it("invokes the selected Python with official APIs and a private source snapshot, returning only verified fields", async () => {
  const f = await fixture();
  let artifacts = "";
  f.execute.mockImplementation(async (python, args, options) => {
    expect(python).toBe(f.ctx.config.evaluation_python);
    expect(args).toEqual(["-I", "-B", "-c", EVALUATION_BRIDGE]);
    expect(options.cwd).toBe(f.checkout);
    expect(JSON.stringify([args, options.env])).not.toContain("secret");
    expect(options.env.PYTHONPATH).toBeUndefined();
    expect(options.env.RIDGES_ENVIRONMENT_TYPE).toBeUndefined();
    const request = JSON.parse(options.input);
    expect(request.key).toBe("runtime-secret");
    expect(options.input).not.toContain("management-secret");
    expect(options.input).not.toContain("ticket-secret");
    expect(request.task).toBe(f.task);
    expect(request.candidate).not.toBe(f.candidate);
    expect(await readFile(request.candidate, "utf8")).toBe(await readFile(f.candidate, "utf8"));
    expect((await stat(request.candidate)).mode & 0o777).toBe(0o600);
    artifacts = request.results;
    await writeFile(join(artifacts, "unredacted.log"), "runtime-secret");
    return JSON.stringify({ ...output, costUsd: 0.12 });
  });
  expect(await evaluateRidges(f.ctx, f.candidate, f.execute)).toEqual({
    evaluator: `ridges-local@${REVIEWED_RIDGES_COMMIT}`, dataset: output.dataset,
    metrics: { reward: 0.75, testsPassed: 3, testsFailed: 1, testsSkipped: 0 }, costUsd: 0.12,
    detail: expect.stringContaining("relaxed production restrictions"),
  });
  await expect(stat(artifacts)).rejects.toMatchObject({ code: "ENOENT" });
  expect(inspect).toHaveBeenCalledTimes(3);
  for (const [command, args, options] of inspect.mock.calls) {
    expect(command).toBe("git");
    expect(args.slice(0, 5)).toEqual(["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", f.checkout]);
    expect(options).toMatchObject({ timeout: 5000, maxBuffer: 65536, killSignal: "SIGKILL" });
    expect(options.shell).toBeUndefined();
  }
});

it("requires local selections and a runtime key, without wallet or registration", async () => {
  const f = await fixture();
  f.ctx.config.evaluation_checkout = "relative";
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("absolute local directory");
  f.ctx.config.evaluation_checkout = f.checkout;
  f.ctx.config.evaluation_commit = "main";
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("evaluation_commit");
  f.ctx.config.evaluation_commit = REVIEWED_RIDGES_COMMIT;
  delete f.ctx.config.evaluation_task;
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("evaluation_task");
  f.ctx.config.evaluation_task = f.task;
  delete f.ctx.config.openrouter_api_key;
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("openrouter_api_key");
  expect(f.execute).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
});

it("rejects changed HEAD, dirty checkouts and unreviewed revisions before running Python", async () => {
  const f = await fixture();
  inspect.mockResolvedValueOnce({ stdout: f.checkout }).mockResolvedValueOnce({ stdout: "0".repeat(40) });
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("HEAD does not match");
  inspect.mockResolvedValueOnce({ stdout: f.checkout }).mockResolvedValueOnce({ stdout: REVIEWED_RIDGES_COMMIT })
    .mockResolvedValueOnce({ stdout: "?? extra.py" });
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("must be clean");
  f.ctx.config.evaluation_commit = "a".repeat(40);
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("Unsupported Ridges evaluator revision");
  expect(f.execute).not.toHaveBeenCalled();
});

it("rejects non-task datasets, symlink metadata and oversized candidates", async () => {
  const f = await fixture();
  await rm(join(f.task, "instruction.md"));
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("Select one materialized Harbor task");
  await symlink(f.candidate, join(f.task, "instruction.md"));
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("Select one materialized Harbor task");
  await writeFile(f.candidate, Buffer.alloc(1024 * 1024 + 1));
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow("at most 1 MiB");
  expect(f.execute).not.toHaveBeenCalled();
});

it("keeps unknown cost absent and real zero reward numeric", async () => {
  const f = await fixture();
  f.execute.mockResolvedValue(JSON.stringify({ ...output, reward: 0 }));
  const result = await evaluateRidges(f.ctx, f.candidate, f.execute);
  expect(result.metrics.reward).toBe(0);
  expect(result).not.toHaveProperty("costUsd");
});

it("rejects missing, fabricated, oversized and non-finite results without leaking output", async () => {
  const f = await fixture();
  for (const invalid of ["runtime-secret", "x".repeat(65537), JSON.stringify({ score: 1 }),
    JSON.stringify({ ...output, reward: null }), JSON.stringify({ ...output, reward: true }),
    JSON.stringify({ ...output, costUsd: -1 }), JSON.stringify({ ...output, log: "runtime-secret" }),
    JSON.stringify(output).replace('"reward":0.75', '"reward":1e999')]) {
    f.execute.mockResolvedValueOnce(invalid);
    await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow(/^Ridges evaluation failed, timed out or returned invalid results\./);
  }
});

it("cleans private artifacts after evaluator failure and suppresses error credentials", async () => {
  const f = await fixture();
  let artifacts = "";
  f.execute.mockImplementation(async (_python, _args, options) => {
    artifacts = JSON.parse(options.input).results;
    await writeFile(join(artifacts, "log"), "runtime-secret");
    throw Error("runtime-secret management-secret ticket-secret");
  });
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow(/^Ridges evaluation failed, timed out or returned invalid results\./);
  await expect(stat(artifacts)).rejects.toMatchObject({ code: "ENOENT" });
  inspect.mockRejectedValueOnce(Error("runtime-secret"));
  await expect(evaluateRidges(f.ctx, f.candidate, f.execute)).rejects.toThrow(/^Cannot inspect the Ridges evaluator checkout within the read-only limits$/);
});

it("runs the bridge against a no-inference API fixture, calling the official converter seam and suppressing global prune", async () => {
  const f = await fixture();
  // Only fixture modules execute on the host. The candidate raises if imported.
  const harness = String.raw`
import json, sys, types
from pathlib import Path
request = json.load(sys.stdin)
bridge = request.pop("bridge")
def module(name):
    value = types.ModuleType(name)
    sys.modules[name] = value
    return value
miners = module("miners")
local = module("miners.local_harbor")
miners.local_harbor = local
miners.LocalInferenceConfig = lambda **kw: kw
async def forbidden_prune():
    raise AssertionError("global Docker prune must not run")
local.prune_dangling_images = forbidden_prune
async def run_local_task(task, **kw):
    assert Path(kw["agent_path"]).read_text().startswith("raise RuntimeError")
    assert kw["task_digest"] == "sha256:" + "a" * 64
    assert kw["inference"] == {"provider": "openrouter", "api_key": "runtime-secret"}
    assert kw["agent_timeout_sec"] == 600
    await local.prune_dangling_images()
    print("upstream secret log", file=sys.stderr)
    print("upstream secret stdout")
    return "official-summary-fixture"
local.run_local_task = run_local_task
module("execution")
artifacts = module("execution.artifacts")
def convert(summary):
    assert summary == "official-summary-fixture"
    return types.SimpleNamespace(verifier_reward=0.75,
        test_results=[types.SimpleNamespace(status=s) for s in ["pass", "pass", "pass", "fail"]], cost_usd=None)
artifacts.result_from_summary = convert
module("ridges_harbor")
module("ridges_harbor.digest").compute_task_digest = lambda path: "sha256:" + "a" * 64
import io
sys.stdin = io.StringIO(json.dumps(request))
exec(compile(bridge, "fez-ridges-bridge", "exec"))
`;
  const result = execFileSync("python3", ["-I", "-c", harness], { encoding: "utf8", timeout: 5000,
    input: JSON.stringify({ bridge: EVALUATION_BRIDGE, checkout: f.checkout, task: f.task,
      candidate: f.candidate, results: f.task, key: "runtime-secret" }), maxBuffer: 65536 });
  expect(JSON.parse(result)).toEqual(output);
  expect(result).not.toContain("secret");
});

it("forwards an explicit Docker platform for x86 benchmark images on ARM hosts", async () => {
  const f = await fixture();
  vi.stubEnv("DOCKER_DEFAULT_PLATFORM", "linux/amd64");
  try {
    await evaluateRidges(f.ctx, f.candidate, f.execute);
    expect(f.execute.mock.calls[0][2].env.DOCKER_DEFAULT_PLATFORM).toBe("linux/amd64");
  } finally { vi.unstubAllEnvs(); }
});
