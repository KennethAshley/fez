import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import type { SubmissionContext } from "@fezchat/extension-api";
import { source } from "./miner-check.js";

export const REVIEWED_RIDGES_COMMIT = "56406a15eccfca8417030e87b9d0ef34cbcd8d5a";
export const ridgesDevelopmentInstructions =
  "Build a Python agent_main(input) that returns a patch. Test checks syntax only; Evaluate runs one real task in official Ridges Docker local mode. " +
  "Follow https://docs.ridges.ai/guides/agent-contract for inference, repository access and budget/time limits. " +
  "Local mode relaxes production restrictions; its reward is a development result, not a production prediction. " +
  `Select a clean official Ridges checkout pinned to ${REVIEWED_RIDGES_COMMIT}, its installed Python (3.12.3–3.13, miner dependencies), ` +
  "and a trusted local Harbor task directory (instruction.md, task.toml, environment/). Use absolute paths. " +
  "Start Docker and configure the OpenRouter runtime key. Evaluation requires an explicit request and can bill inference; no wallet or upload ticket is needed. " +
  "Run only one evaluation per Docker daemon. Runs allow 15 minutes plus cleanup; after interruption, inspect Docker before retrying. " +
  "Raw logs are discarded to protect credentials. Missing reward or cost is never reported as zero.";

// This bridge uses upstream's runner AND result converter. Candidate source is
// only passed as agent_path; the official runtime uploads it into Harbor Docker.
export const EVALUATION_BRIDGE = String.raw`
import asyncio, contextlib, json, os, sys
from pathlib import Path
request = json.load(sys.stdin)
sys.path.insert(0, request["checkout"])
def check_tree(directory):
    count = total = 0
    for root, dirs, files in os.walk(directory, followlinks=False):
        count += len(dirs) + len(files)
        if count > 10000:
            raise ValueError("too many files")
        for name in dirs + files:
            path = Path(root) / name
            if path.is_symlink():
                raise ValueError("symlink")
            if path.is_file():
                size = path.stat().st_size
                total += size
                if size > 64 * 1024 * 1024 or total > 512 * 1024 * 1024:
                    raise ValueError("files too large")
            elif not path.is_dir():
                raise ValueError("special file")
async def run():
    from miners import LocalInferenceConfig
    from miners import local_harbor
    from execution.artifacts import result_from_summary
    from ridges_harbor.digest import compute_task_digest
    # The official local runner prunes the entire daemon's dangling images.
    # Suppress only that maintenance operation in this short-lived process.
    async def no_global_prune():
        pass
    local_harbor.prune_dangling_images = no_global_prune
    task = Path(request["task"])
    check_tree(task)
    digest = compute_task_digest(task)
    summary = await local_harbor.run_local_task(
        task, agent_path=request["candidate"],
        inference=LocalInferenceConfig(provider="openrouter", api_key=request["key"]),
        task_digest=digest, agent_timeout_sec=600,
        results_dir=request["results"], debug=False,
    )
    check_tree(Path(request["results"]))
    result = result_from_summary(summary)
    payload = {"dataset": digest, "reward": result.verifier_reward,
        "passed": sum(t.status == "pass" for t in result.test_results),
        "failed": sum(t.status == "fail" for t in result.test_results),
        "skipped": sum(t.status == "skip" for t in result.test_results)}
    if result.cost_usd is not None:
        payload["costUsd"] = result.cost_usd
    return payload
try:
    # No upstream logs, exception text, patches, paths or credentials cross stdout.
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        payload = asyncio.run(asyncio.wait_for(run(), timeout=900))
    print(json.dumps(payload, allow_nan=False))
except BaseException:
    sys.exit(1)
`;

const exec = promisify(execFile);
export type EvaluationProcess = (python: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; input: string;
}) => Promise<string>;
const runProcess: EvaluationProcess = (python, args, options) => new Promise((resolve, reject) => {
  const child = execFile(python, args, { cwd: options.cwd, env: options.env,
    timeout: 960000, maxBuffer: 65536, killSignal: "SIGKILL", encoding: "utf8" }, (error, stdout) => {
    if (error) reject(Error("Ridges evaluation failed or timed out; check setup and Docker before retrying. Inference may have been billed."));
    else resolve(stdout);
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(options.input);
});

function field(ctx: SubmissionContext, key: string, pattern?: RegExp): string {
  const value = ctx.config[key];
  // eslint-disable-next-line no-control-regex -- Reject or strip control characters from untrusted text.
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || (pattern && !pattern.test(value))) {
    throw Error(`Configure a valid Ridges ${key}`);
  }
  return value;
}
async function directory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw Error(`Ridges ${label} must be an absolute local directory`);
  try {
    if (!(await lstat(path)).isDirectory()) throw Error();
    return await realpath(path);
  } catch { throw Error(`Ridges ${label} must be an existing local directory, not a symlink`); }
}
async function git(checkout: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", checkout, ...args], {
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      timeout: 5000, maxBuffer: 65536, killSignal: "SIGKILL", encoding: "utf8",
    });
    return stdout.trim();
  } catch { throw Error("Cannot inspect the Ridges evaluator checkout within the read-only limits"); }
}
const resultSchema = z.object({
  dataset: z.string().regex(/^sha256:[0-9a-f]{64}$/), reward: z.number().finite(),
  passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative().optional(),
}).strict();

/** Only explicit development.evaluate calls this; setup/test/status never run inference. */
export async function evaluateRidges(ctx: SubmissionContext, sourcePath: string, execute: EvaluationProcess = runProcess) {
  const checkout = await directory(field(ctx, "evaluation_checkout"), "evaluation checkout");
  const commit = field(ctx, "evaluation_commit", /^[0-9a-f]{40}$/);
  const task = await directory(field(ctx, "evaluation_task"), "evaluation task");
  const python = field(ctx, "evaluation_python");
  if (!isAbsolute(python)) throw Error("Select the absolute path to the evaluator's installed Python");
  const key = field(ctx, "openrouter_api_key").trim();
  if (!key) throw Error("Configure the OpenRouter runtime key");
  if (!isAbsolute(sourcePath)) throw Error("Ridges candidate must be an absolute local Python file");
  let bytes: Buffer;
  try { bytes = await source(sourcePath); }
  catch { throw Error("Ridges candidate must be a readable nonempty regular file of at most 1 MiB"); }
  if (await git(checkout, ["rev-parse", "--show-toplevel"]) !== checkout) throw Error("Select the root of the Ridges evaluator checkout");
  if (await git(checkout, ["rev-parse", "--verify", "HEAD"]) !== commit) throw Error("Ridges evaluator HEAD does not match evaluation_commit");
  if (await git(checkout, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])) {
    throw Error("Ridges evaluator checkout must be clean, including untracked files");
  }
  if (commit !== REVIEWED_RIDGES_COMMIT) throw Error("Unsupported Ridges evaluator revision; review its runtime and result contract before enabling it");
  try {
    for (const name of ["instruction.md", "task.toml"]) {
      const stat = await lstat(join(task, name));
      if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw Error();
    }
    if (!(await lstat(join(task, "environment"))).isDirectory()) throw Error();
  } catch { throw Error("Select one materialized Harbor task with regular instruction.md, task.toml and environment/; archives and automatic dataset downloads are unsupported"); }
  // Private per-run artifacts may contain the runtime key. Retain only numeric results.
  const temporary = await mkdtemp(join(tmpdir(), "fez-ridges-evaluation-"));
  try {
    const candidate = join(temporary, "agent.py");
    await writeFile(candidate, bytes, { mode: 0o600 });
    const results = join(temporary, "results");
    await mkdir(results, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: temporary };
    for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_DEFAULT_PLATFORM"]) if (process.env[name]) env[name] = process.env[name];
    let result: z.infer<typeof resultSchema>;
    try {
      const output = await execute(python, ["-I", "-B", "-c", EVALUATION_BRIDGE], {
        cwd: checkout, env, input: JSON.stringify({ checkout, task, candidate, results, key }),
      });
      if (Buffer.byteLength(output) > 65536) throw Error();
      result = resultSchema.parse(JSON.parse(output));
    } catch { throw Error("Ridges evaluation failed, timed out or returned invalid results. Check the selected Python, dependencies, task, runtime key and Docker; inference may have been billed."); }
    return { evaluator: `ridges-local@${commit}`, dataset: result.dataset,
      metrics: { reward: result.reward, testsPassed: result.passed, testsFailed: result.failed, testsSkipped: result.skipped },
      detail: "One official Harbor local Docker task; relaxed production restrictions. Development reward, not a production prediction. Raw logs discarded.",
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
