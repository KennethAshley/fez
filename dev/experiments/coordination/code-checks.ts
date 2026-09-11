import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const limits = { timeoutMs: 5000, outputBytesPerStream: 65536, heapMiB: 64, artifactBytes: 131072 };
// ponytail: reviewed local fixtures only; hostile miners need a VM and grading outside their process.
const profile = `(version 1)
(deny default)
(import "dyld-support.sb")
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (literal (param "NODE")) (subpath (param "WORK")) (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib") (literal (param "NODE")))
(allow process-exec (literal (param "NODE")))`;
const armNames = ["individual", "fixed-workflow", "adaptive"];
type TestName = "acceptance.test.mjs" | "regression.test.mjs" | "isolation.test.mjs";

interface TestCounts { total: number; passed: number; failed: number; cancelled: number; skipped: number; todo: number }
export interface TestObservation {
  verdict: "passed" | "failed" | "unavailable";
  exitCode: number | null; signal: string | null; timedOut: boolean; outputLimitExceeded: boolean;
  elapsedMs: number; tests: TestCounts | null; stdout: string; stderr: string;
  artifactHashes: Record<string, string>;
}

function testCounts(stdout: string): TestCounts | null {
  const values: number[] = [];
  for (const label of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...stdout.matchAll(new RegExp(`^# ${label} (\\d+)\\r?$`, "gm"))];
    if (matches.length !== 1) return null;
    values.push(Number(matches[0][1]));
  }
  const [total, passed, failed, cancelled, skipped, todo] = values;
  if (!values.every(Number.isSafeInteger) || total < 1 || total !== passed + failed + cancelled + skipped + todo) return null;
  return { total, passed, failed, cancelled, skipped, todo };
}

/** OS-contained observations for reviewed local fixtures; child output is not a hostile-miner attestation. */
export async function runIsolatedTests(directory: string, code: string, tests: string, testName: TestName = "acceptance.test.mjs"): Promise<TestObservation> {
  assert(process.platform === "darwin" && Number(process.versions.node.split(".")[0]) >= 24, "code checks require macOS and Node 24+");
  assert(["acceptance.test.mjs", "regression.test.mjs", "isolation.test.mjs"].includes(testName), "invalid test filename");
  for (const text of [code, tests]) assert(typeof text === "string" && Buffer.byteLength(text) <= limits.artifactBytes, "artifact exceeds limit");
  await mkdir(resolve(directory));
  const work = await realpath(directory);
  const node = await realpath(process.execPath);
  await writeFile(join(work, "task.mjs"), code, { flag: "wx" });
  await writeFile(join(work, testName), tests, { flag: "wx" });
  const started = performance.now();
  const result: TestObservation = { verdict: "unavailable", exitCode: null, signal: null, timedOut: false, outputLimitExceeded: false,
    elapsedMs: 0, tests: null, stdout: "", stderr: "", artifactHashes: { "task.mjs": hash(code), [testName]: hash(tests) } };
  try {
    const output = await execute("/usr/bin/sandbox-exec", ["-p", profile, "-D", `NODE=${node}`, "-D", `WORK=${work}`, node,
      "--no-addons", `--max-old-space-size=${limits.heapMiB}`, "--test", "--test-isolation=none", "--test-reporter=tap", testName],
    { cwd: work, env: { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" }, timeout: limits.timeoutMs,
      killSignal: "SIGKILL", maxBuffer: limits.outputBytesPerStream, encoding: "utf8" });
    result.exitCode = 0; result.stdout = output.stdout; result.stderr = output.stderr;
  } catch (error) {
    const failure = error as { code?: number | string; signal?: string; killed?: boolean; stdout?: string; stderr?: string };
    result.exitCode = typeof failure.code === "number" ? failure.code : null;
    result.signal = failure.signal ?? null;
    result.outputLimitExceeded = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    result.timedOut = failure.killed === true && !result.outputLimitExceeded;
    result.stdout = failure.stdout ?? ""; result.stderr = failure.stderr ?? "sandbox process unavailable";
  }
  result.elapsedMs = Math.round(performance.now() - started);
  result.stdout = Buffer.from(result.stdout).subarray(0, limits.outputBytesPerStream).toString();
  result.stderr = Buffer.from(result.stderr).subarray(0, limits.outputBytesPerStream).toString();
  result.tests = testCounts(result.stdout);
  if (!result.signal && !result.timedOut && !result.outputLimitExceeded && result.tests) {
    const { total, passed, failed, cancelled, skipped, todo } = result.tests;
    if (result.exitCode === 0 && passed === total && !failed && !cancelled && !skipped && !todo) result.verdict = "passed";
    if (result.exitCode === 1 && failed > 0 && !cancelled && !skipped && !todo) result.verdict = "failed";
  }
  await writeFile(join(work, "observation.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}

async function readRegular(path: string, maxBytes: number): Promise<Buffer> {
  assert((await lstat(path)).isFile(), "expected regular file, not symlink");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert((await file.stat()).size <= maxBytes, "file exceeds limit");
    const bytes = await file.readFile();
    assert(bytes.length <= maxBytes, "file exceeds limit");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes;
  } finally { await file.close(); }
}

interface CodeArm {
  name: string; acceptance: TestObservation | null; regressionRepair: TestObservation | null; regressionStarter: TestObservation | null;
  regressionDemonstrated: boolean | null; accepted: null; assessment: null;
}

/** Adds a separate evidence report; never edits the source pilot or turns child output into a reward score. */
export async function verifyPilotCode(reportPath: string, directory: string, packDirectory: string) {
  const reportBytes = await readRegular(resolve(reportPath), 8 * 1024 * 1024);
  const report = JSON.parse(reportBytes.toString());
  assert(report.complete === true && Array.isArray(report.arms), "complete saved pilot required");
  assert.deepEqual(report.arms.map((a: { name: string }) => a.name), armNames, "invalid pilot arms");
  assert.equal(hash(JSON.stringify(report.conditions)), report.conditionsSha256, "conditions hash mismatch");
  const packBytes = await readRegular(join(packDirectory, "development-pack.json"), 2 * 1024 * 1024);
  assert.equal(hash(packBytes), report.conditions.packSha256, "task pack hash mismatch");
  const pack = JSON.parse(packBytes.toString());
  const task = pack.tasks.find((t: { id: string }) => t.id === report.conditions.config.taskId);
  assert(task?.fixture && pack.fixtures[task.fixture], "saved task has no code fixture");
  const fixture = pack.fixtures[task.fixture];
  const base = await realpath(dirname(resolve(reportPath)));
  const artifacts: (Record<string, string> | null)[] = [];
  for (const arm of report.arms) {
    assert(["delivered", "failed"].includes(arm.status), "invalid arm status");
    if (arm.status === "failed") { artifacts.push(null); continue; }
    const parent = join(base, arm.name, "delivered");
    assert.equal(await realpath(parent), parent, "symlink in artifact directory");
    assert.deepEqual(Object.keys(arm.artifacts).sort(), ["answer.md", "regression.test.mjs", "task.mjs"], "invalid artifact names");
    const files: Record<string, string> = {};
    for (const name of Object.keys(arm.artifacts)) {
      const bytes = await readRegular(join(parent, name), limits.artifactBytes);
      assert.equal(hash(bytes), arm.artifacts[name], `artifact hash mismatch: ${arm.name}/${name}`);
      files[name] = bytes.toString();
    }
    artifacts.push(files);
  }
  const output = resolve(directory);
  await mkdir(output);
  await writeFile(join(output, "host-canary"), "isolation dummy; no credential", { flag: "wx" });
  const isolation = await runIsolatedTests(join(output, "isolation"), "export {};", `
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {createConnection} from 'node:net';
test('filesystem and subprocess denied; environment cleared',()=>{
 assert.throws(()=>readFileSync('../host-canary'),{code:'EPERM'});
 assert.throws(()=>writeFileSync('./task.mjs','overwrite'),{code:'EPERM'});
 assert.throws(()=>writeFileSync('../host-canary','overwrite'),{code:'EPERM'});
 assert.equal(spawnSync(process.execPath,['-e','process.exit(0)']).error.code,'EPERM');
 assert.deepEqual(Object.keys(process.env).filter(k=>k!=='NODE_TEST_WORKER_ID').sort(),['LANG','PATH','TZ']);
});
test('network denied',async()=>{
 const error=await new Promise(resolve=>{const s=createConnection({host:'127.0.0.1',port:9});s.on('error',e=>{s.destroy();resolve(e)});s.on('connect',()=>{s.destroy();resolve(null)})});
 assert.equal(error.code,'EPERM');
});`, "isolation.test.mjs");
  assert.equal(isolation.verdict, "passed", "isolation control failed; refusing model code");
  const starter = await runIsolatedTests(join(output, "control-starter"), fixture.starter, fixture.checks);
  const reference = await runIsolatedTests(join(output, "control-reference"), fixture.reference, fixture.checks);
  assert(starter.verdict === "failed" && reference.verdict === "passed", "fixture controls failed; refusing model code");
  const result = { version: "fez-local-code-observations-v1", sourceReportSha256: hash(reportBytes), conditionsSha256: report.conditionsSha256,
    taskId: task.id as string, createdAt: new Date().toISOString(), runtime: { platform: process.platform, release: release(), node: process.version,
      profile, profileSha256: hash(profile), dyldRulesSha256: hash(await readFile("/System/Library/Sandbox/Profiles/dyld-support.sb")), limits },
    trust: "reviewed-local-fixtures; child test reports are not hostile-miner attestations", costMicrousd: null, assessment: null,
    controls: { isolation, starter, reference }, arms: [] as CodeArm[] };
  for (let i = 0; i < armNames.length; i++) {
    const name = armNames[i], files = artifacts[i];
    const arm: CodeArm = { name, acceptance: null, regressionRepair: null, regressionStarter: null, regressionDemonstrated: null, accepted: null, assessment: null };
    if (files) {
      arm.acceptance = await runIsolatedTests(join(output, `${name}-acceptance`), files["task.mjs"], fixture.checks);
      arm.regressionRepair = await runIsolatedTests(join(output, `${name}-regression-repair`), files["task.mjs"], files["regression.test.mjs"], "regression.test.mjs");
      arm.regressionStarter = await runIsolatedTests(join(output, `${name}-regression-starter`), fixture.starter, files["regression.test.mjs"], "regression.test.mjs");
      if (arm.regressionRepair.verdict !== "unavailable" && arm.regressionStarter.verdict !== "unavailable") {
        arm.regressionDemonstrated = arm.regressionRepair.verdict === "passed" && arm.regressionStarter.verdict === "failed";
      }
    }
    result.arms.push(arm);
    await writeFile(join(output, "verification.json"), JSON.stringify(result, null, 2) + "\n");
  }
  return result;
}
