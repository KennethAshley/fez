import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const repositoryWritablePaths = ["packages/fez-acp/src/hire-delivery.ts", "packages/fez-evals/tests/hire-delivery.test.ts", "packages/fez-acp/README.md"] as const;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);
const limits = { fileBytes: 2_097_152, writeBytes: 131_072, readLines: 200, outputBytesPerStream: 131_072, timeoutMs: 30_000, heapMiB: 512 };
const git = "/Library/Developer/CommandLineTools/usr/bin/git";
// ponytail: local development observations only; hostile submissions need a VM with hard process/memory quotas.
const profile = `(version 1)
(deny default)
(import "dyld-support.sb")
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-read-metadata)
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share")
 (subpath "/Library/Developer/CommandLineTools") (literal (param "NODE")) (literal "/bin/sh") (literal "/bin/bash")
 (subpath (param "REPO")) (subpath (param "JOB"))
 (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write* (subpath (param "SCRATCH")) (literal "/dev/null"))
(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib")
 (subpath "/Library/Developer/CommandLineTools") (subpath (param "REPO")) (literal (param "NODE")) (literal "/bin/sh") (literal "/bin/bash"))
(allow process-fork)
(allow process-exec (literal (param "NODE")) (literal (param "GIT")) (literal "/bin/sh") (literal "/bin/bash")
 (literal (param "ESBUILD"))
 (subpath "/Library/Developer/CommandLineTools/usr/libexec/git-core")
 (subpath (param "SCRATCH")))`;

export const repositoryToolPolicy = `You have bounded repository tools. Return one JSON action at a time:
{"action":"tool","request":{"name":"list","prefix":"packages/fez-acp/"}}
{"action":"tool","request":{"name":"read","path":"packages/fez-acp/src/hire-delivery.ts","startLine":1,"lineCount":200}}
{"action":"tool","request":{"name":"write","path":"...","sha256":"hash from latest read","content":"complete new file text"}}
{"action":"tool","request":{"name":"check","check":"delivery-tests"}}
Checks: delivery-tests (Vitest), types (ACP TypeScript). No arbitrary commands. Reads return a whole-file hash plus a bounded line range.
Only these files are writable: ${repositoryWritablePaths.join(", ")}.
Each arm has its own checkout. Lead and specialists in that arm share edits sequentially. A write changes the checkout immediately.
Tool observations are development evidence, not independent acceptance. Cite actual observations; do not invent test runs.
Specialists can use tools before submitting. Submit {"action":"submit","files":{"answer.md":"concise changes, observations, remaining limitations"}}.
The host captures the three repository files on final lead submission. Only the lead may delegate when its arm permits it.`;

function object(value: unknown): asserts value is Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "tool request must be an object");
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  assert(required.every(key => key in value) && Object.keys(value).every(key => [...required, ...optional].includes(key)), "invalid tool fields");
}
function safePath(value: unknown): asserts value is string {
  assert(typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every(part => part && !part.startsWith(".") && part !== "node_modules"), "invalid source path");
}
async function regular(path: string) {
  const info = await lstat(path);
  assert(info.isFile() && info.nlink === 1 && await realpath(path) === path, "expected regular file without symlink or hardlink");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert((await handle.stat()).size <= limits.fileBytes, "file exceeds read limit");
    const bytes = await handle.readFile();
    assert(bytes.length <= limits.fileBytes, "file exceeds read limit");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally { await handle.close(); }
}

/** Caller owns the prepared checkout exclusively; candidate processes cannot write it or the tool evidence. */
export async function createRepositoryTools(checkout: string, directory: string) {
  const repo = await realpath(checkout);
  assert((await lstat(join(repo, ".git"))).isDirectory(), "independent Git checkout required");
  const listed = await execute("git", ["-c", "core.fsmonitor=false", "-C", repo, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 4_194_304 });
  const tracked = new Set(listed.stdout.split("\0").filter(path => {
    try { safePath(path); return /\.(?:[cm]?[jt]sx?|md|json|toml|yaml|yml|rs)$/.test(path); } catch { return false; }
  }));
  const snapshot = async (): Promise<Record<string, string>> => Object.fromEntries(await Promise.all(repositoryWritablePaths.map(async path => {
    assert(tracked.has(path), "task file missing from checkout");
    return [path, await regular(join(repo, path))] as const;
  })));
  const initial = await snapshot();
  const output = resolve(directory);
  assert(!output.startsWith(repo + "/") && output !== repo, "evidence must be outside checkout");
  await mkdir(output);
  const evidence = await realpath(output);
  assert(!evidence.startsWith(repo + "/"), "evidence must be outside checkout");
  const node = await realpath(process.execPath);
  const conditions = { version: "fez-r01-repository-tools-v1", repo, node, nodeVersion: process.version, git, profile, limits,
    policy: repositoryToolPolicy, writable: repositoryWritablePaths, initialHashes: Object.fromEntries(Object.entries(initial).map(([path, text]) => [path, hash(text)])) };
  await writeFile(join(evidence, "tools.json"), JSON.stringify(conditions, null, 2) + "\n", { flag: "wx" });
  let busy = false, sequence = 0;


  return { conditions, snapshot,
    async execute(request: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
      assert(!busy, "repository tool already in progress");
      busy = true;
      const id = String(++sequence).padStart(4, "0");
      let result: Record<string, unknown>;
      try {
        signal?.throwIfAborted(); object(request);
        if (request.name === "list") {
          fields(request, ["name", "prefix"]);
          assert(typeof request.prefix === "string" && request.prefix.length <= 512, "invalid prefix");
          const paths = [...tracked].filter(path => path.startsWith(request.prefix as string)).sort();
          result = { paths: paths.slice(0, 400), total: paths.length };
        } else if (request.name === "check") {
          fields(request, ["name", "check"]);
          result = await runRepositoryCheck(repo, join(evidence, `check-${id}`), request.check, signal);
        } else {
          assert(request.name === "read" || request.name === "write", "unknown repository tool");
          fields(request, request.name === "read" ? ["name", "path"] : ["name", "path", "sha256", "content"], request.name === "read" ? ["startLine", "lineCount"] : []);
          safePath(request.path); assert(tracked.has(request.path), "path is not tracked source");
          const path = join(repo, request.path), before = await regular(path);
          if (request.name === "read") {
            const start = request.startLine ?? 1, count = request.lineCount ?? limits.readLines;
            assert(typeof start === "number" && Number.isSafeInteger(start) && start >= 1 &&
              typeof count === "number" && Number.isSafeInteger(count) && count >= 1 && count <= limits.readLines, "invalid line range");
            const lines = before.split("\n");
            const content = lines.slice(start - 1, start - 1 + count).join("\n");
            assert(Buffer.byteLength(content) <= limits.writeBytes, "read range exceeds byte limit; request fewer lines");
            result = { path: request.path, sha256: hash(before), startLine: start, totalLines: lines.length, content };
          } else {
            assert(repositoryWritablePaths.some(path => path === request.path), "path is not writable");
            assert(typeof request.sha256 === "string" && request.sha256 === hash(before), "file changed; read it again before writing");
            assert(typeof request.content === "string" && Buffer.from(request.content).toString() === request.content && !request.content.includes("\0") &&
              Buffer.byteLength(request.content) <= limits.writeBytes, "invalid write content");
            const file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
            try { await file.writeFile(request.content); await file.truncate(Buffer.byteLength(request.content)); } finally { await file.close(); }
            result = { path: request.path, sha256: hash(request.content), previousSha256: hash(before) };
          }
        }
        await writeFile(join(evidence, `tool-${id}.json`), JSON.stringify({ request, result }, null, 2) + "\n", { flag: "wx" });
        return result;
      } catch (error) {
        await writeFile(join(evidence, `tool-${id}.json`), JSON.stringify({ request, error: error instanceof Error ? error.message : "repository tool failed" }, null, 2) + "\n", { flag: "wx" });
        throw error;
      } finally { busy = false; }
    },
  };
}

/** Trusted evaluator entry point; overrides are never exposed by the model tool API. */
export async function runRepositoryCheck(checkout: string, directory: string, name: unknown, signal?: AbortSignal,
  overrides?: { tests?: string; helper?: string }) {
  const repo = await realpath(checkout), node = await realpath(process.execPath);
  const job = join(await realpath(dirname(resolve(directory))), basename(directory));
  assert(!job.startsWith(repo + "/") && job !== repo, "check evidence must be outside checkout");
  const snapshot = async () => Object.fromEntries(await Promise.all(repositoryWritablePaths.map(async path => [path, await regular(join(repo, path))] as const)));
  assert(name === "delivery-tests" || name === "types", "unknown named check");
  assert(process.platform === "darwin" && Number(process.versions.node.split(".")[0]) >= 24, "repository checks require macOS and Node 24+");
  await mkdir(job);
  const scratch = join(job, "scratch"); await mkdir(scratch);
  const replacements: Record<string, string> = {};
  for (const [key, source] of Object.entries(overrides ?? {})) {
    assert((key === "tests" || key === "helper") && typeof source === "string" && Buffer.byteLength(source) <= limits.writeBytes, "invalid evaluator override");
    const file = join(job, `evaluator-${key}.ts`);
    await writeFile(file, source, { flag: "wx" });
    replacements[join(repo, key === "tests" ? repositoryWritablePaths[1] : repositoryWritablePaths[0])] = file;
  }
  await writeFile(join(job, "empty-config"), "", { flag: "wx" });
  const launcher = join(job, "check.mjs");
  // Programmatic Vitest avoids writing a bundled config into the read-only checkout.
  await writeFile(launcher, name === "types" ?
    `import ${JSON.stringify(pathToFileURL(join(repo, "node_modules/typescript/bin/tsc")).href)};` :
    `import {readFileSync} from 'node:fs';
import {startVitest} from ${JSON.stringify(pathToFileURL(join(repo, "packages/fez-evals/node_modules/vitest/dist/node.js")).href)};
const replacements=${JSON.stringify(replacements)};
await startVitest('test',['tests/hire-delivery.test.ts'],{root:${JSON.stringify(join(repo, "packages/fez-evals"))},config:false,run:true,watch:false,cache:false,pool:'threads',maxWorkers:1,minWorkers:1,reporters:['default','json'],outputFile:{json:${JSON.stringify(join(scratch, "tests.json"))}}},{server:{hmr:false,host:'127.0.0.1'},plugins:[{name:'frozen-evaluator-inputs',enforce:'pre',load(id){const file=replacements[id.split('?')[0]];if(file)return readFileSync(file,'utf8')}}]});`, { flag: "wx" });
  const esbuild = await realpath(join(repo, `packages/fez-evals/node_modules/@esbuild/darwin-${process.arch}/bin/esbuild`));
  assert(esbuild.startsWith(repo + "/"), "esbuild must be inside checkout");
  const args = ["-p", profile, "-D", `REPO=${repo}`, "-D", `NODE=${node}`, "-D", `JOB=${job}`, "-D", `SCRATCH=${scratch}`, "-D", `GIT=${git}`, "-D", `ESBUILD=${esbuild}`,
    node, `--max-old-space-size=${limits.heapMiB}`, launcher,
    ...(name === "types" ? ["--noEmit", "-p", join(repo, "packages/fez-acp/tsconfig.json")] : [])];
  const env = { PATH: `${dirname(git)}:${dirname(node)}:/usr/bin:/bin`, LANG: "C", TZ: "UTC", TMPDIR: scratch,
    GIT_CONFIG_GLOBAL: join(job, "empty-config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const result = { check: name, exitCode: null as number | null, signal: null as string | null, timedOut: false, outputLimitExceeded: false,
    aborted: false, elapsedMs: 0, stdout: "", stderr: "", accepted: null, testReport: null as unknown,
    runtime: { nodeVersion: process.version, node, git, profileSha256: hash(profile), limits,
      loaderRulesSha256: hash(await readFile("/System/Library/Sandbox/Profiles/dyld-support.sb")) },
    overrideHashes: Object.fromEntries(Object.entries(overrides ?? {}).map(([name, text]) => [name, hash(text)])),
    inputHashes: Object.fromEntries(Object.entries(await snapshot()).map(([path, text]) => [path, hash(text)])) };
  const started = performance.now();
  await new Promise<void>(resolve => {
    const child = spawn("/usr/bin/sandbox-exec", args, { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } } };
    const abort = () => { result.aborted = true; stop(); };
    const timer = setTimeout(() => { result.timedOut = true; stop(); }, limits.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const buffers: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    for (const stream of ["stdout", "stderr"] as const) child[stream].on("data", (data: Buffer) => {
      buffers[stream].push(data.subarray(0, Math.max(0, limits.outputBytesPerStream - sizes[stream])));
      sizes[stream] += data.length;
      if (sizes[stream] > limits.outputBytesPerStream) { result.outputLimitExceeded = true; stop(); }
    });
    child.on("error", () => { result.stderr = "sandbox process unavailable"; });
    child.on("close", (code, exitSignal) => {
      stop(); clearTimeout(timer); signal?.removeEventListener("abort", abort);
      result.exitCode = code; result.signal = exitSignal;
      result.stdout = Buffer.concat(buffers.stdout).toString(); result.stderr += Buffer.concat(buffers.stderr).toString();
      resolve();
    });
  });
  result.elapsedMs = Math.round(performance.now() - started);
  try { result.testReport = JSON.parse(await regular(join(scratch, "tests.json"))); } catch { /* Missing/invalid reports remain unavailable. */ }
  assert.deepEqual(Object.fromEntries(Object.entries(await snapshot()).map(([path, text]) => [path, hash(text)])), result.inputHashes, "check modified source files");
  await writeFile(join(job, "observation.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}
