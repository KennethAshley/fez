import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runIsolatedTests, verifyPilotCode } from "../../../dev/experiments/coordination/code-checks.js";

const packDirectory = fileURLToPath(new URL("../../../dev/experiments/coordination/", import.meta.url));
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const macTest = it.skipIf(process.platform !== "darwin");

async function savedPilot(dir: string) {
  const bytes = await readFile(join(packDirectory, "development-pack.json"));
  const pack = JSON.parse(bytes.toString());
  const fixture = pack.fixtures.invoice;
  const regression = `import test from 'node:test';
import assert from 'node:assert/strict';
import {invoiceBalance} from './task.mjs';
test('repeat payment counts once',()=>assert.equal(invoiceBalance(100,[{ref:'a',cents:20},{ref:'a',cents:20}]),80));`;
  const conditions = { config: { taskId: "C01" }, packSha256: hash(bytes) };
  const arms = [];
  for (const name of ["individual", "fixed-workflow", "adaptive"]) {
    const files = { "task.mjs": name === "adaptive" ? fixture.starter : fixture.reference,
      "regression.test.mjs": regression, "answer.md": "No execution claimed." };
    const path = join(dir, name, "delivered");
    await mkdir(path, { recursive: true });
    for (const [file, text] of Object.entries(files)) await writeFile(join(path, file), text);
    arms.push({ name, status: "delivered", artifacts: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, hash(text)])) });
  }
  const report = { complete: true, conditions, conditionsSha256: hash(JSON.stringify(conditions)), arms };
  const reportPath = join(dir, "report.json");
  await writeFile(reportPath, JSON.stringify(report));
  return { reportPath, report, fixture };
}

macTest("observes real acceptance and red/green regression results without changing saved evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fez-code-checks-"));
  try {
    const saved = await savedPilot(dir);
    const before = await readFile(saved.reportPath);
    const output = join(dir, "verified");
    const result = await verifyPilotCode(saved.reportPath, output, packDirectory);
    expect(result.controls.isolation.verdict).toBe("passed");
    expect(result.controls.starter.verdict).toBe("failed");
    expect(result.controls.reference.verdict).toBe("passed");
    expect(result.arms.map(a => a.acceptance?.verdict)).toEqual(["passed", "passed", "failed"]);
    expect(result.arms.map(a => a.regressionDemonstrated)).toEqual([true, true, false]);
    expect(result.arms.every(a => a.assessment === null && a.accepted === null)).toBe(true);
    expect(result.sourceReportSha256).toBe(hash(before));
    expect(await readFile(saved.reportPath)).toEqual(before);
    expect(JSON.parse(await readFile(join(output, "verification.json"), "utf8"))).toEqual(result);
    await expect(verifyPilotCode(saved.reportPath, output, packDirectory)).rejects.toThrow(/exist/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

macTest("OS policy blocks outside reads, all writes, network, subprocesses and inherited credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fez-code-policy-"));
  const old = process.env.FEZ_TEST_ISOLATION_CANARY;
  process.env.FEZ_TEST_ISOLATION_CANARY = "not-for-child";
  try {
    await writeFile(join(dir, "marker"), "private dummy");
    const tests = `import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
import {createConnection} from 'node:net';
test('OS denies files and process launch',()=>{
 assert.throws(()=>readFileSync('../marker'),{code:'EPERM'});
 assert.throws(()=>writeFileSync('./task.mjs','overwrite'),{code:'EPERM'});
 assert.throws(()=>writeFileSync('../marker','overwrite'),{code:'EPERM'});
 assert.equal(spawnSync(process.execPath,['-e','process.exit(0)']).error.code,'EPERM');
 assert.equal(process.env.FEZ_TEST_ISOLATION_CANARY,undefined);
});
test('OS denies network',async()=>{
 const error=await new Promise(resolve=>{const s=createConnection({host:'127.0.0.1',port:9});s.on('error',e=>{s.destroy();resolve(e)});s.on('connect',()=>{s.destroy();resolve(null)})});
 assert.equal(error.code,'EPERM');
});`;
    const result = await runIsolatedTests(join(dir, "job"), "export {};", tests);
    expect(result.verdict, result.stderr + result.stdout).toBe("passed");
    expect(result.tests).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(await readFile(join(dir, "marker"), "utf8")).toBe("private dummy");
  } finally {
    if (old === undefined) delete process.env.FEZ_TEST_ISOLATION_CANARY; else process.env.FEZ_TEST_ISOLATION_CANARY = old;
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);

macTest.each(["silent-exit", "loop", "output-flood"])("does not turn %s into a passing test", async kind => {
  const dir = await mkdtemp(join(tmpdir(), "fez-code-limits-"));
  try {
    // Write to the pipe directly: an unbounded JS write queue can exhaust the heap before testing the host's output cap.
    const code = kind === "silent-exit" ? "process.exit(0);" : kind === "loop" ? "while(true){}" :
      "import {writeSync} from 'node:fs';const chunk=Buffer.alloc(8192,120);while(true)writeSync(1,chunk);";
    const result = await runIsolatedTests(join(dir, "job"), code, "import './task.mjs';");
    expect(result.verdict).toBe("unavailable");
    expect(result.stdout.length).toBeLessThanOrEqual(65536);
    if (kind === "loop") expect(result.timedOut).toBe(true);
    if (kind === "output-flood") expect(result.outputLimitExceeded).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);

macTest.each(["hash", "symlink", "path"])("rejects %s tampering before executing artifacts", async kind => {
  const dir = await mkdtemp(join(tmpdir(), "fez-code-integrity-"));
  try {
    const saved = await savedPilot(dir);
    const target = join(dir, "individual", "delivered", "task.mjs");
    if (kind === "hash") await writeFile(target, "throw new Error('must not execute');");
    if (kind === "symlink") { await rm(target); await symlink(join(dir, "fixed-workflow", "delivered", "task.mjs"), target); }
    if (kind === "path") { saved.report.arms[0].name = "../escape"; await writeFile(saved.reportPath, JSON.stringify(saved.report)); }
    await expect(verifyPilotCode(saved.reportPath, join(dir, "verified"), packDirectory)).rejects.toThrow(/hash|regular|arm|symlink/);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);
