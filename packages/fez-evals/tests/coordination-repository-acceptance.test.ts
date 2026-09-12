import { expect, it } from "vitest";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRepositoryCheck } from "../../../dev/experiments/coordination/repository-tools.js";
import { readRepositoryAssessment, readRegressionEvidence, evaluateRepositoryCode, verifyRepositoryPilot } from "../../../dev/experiments/coordination/repository-acceptance.js";
import { repositoryWritablePaths } from "../../../dev/experiments/coordination/repository-tools.js";

it("requires all eight independent cases and leaves documentation and final acceptance unresolved", () => {
  const assertions = Array.from({ length: 8 }, (_, index) => ({ title: `C${index + 1} requirement`, status: "passed", failureMessages: [] }));
  const run = { exitCode: 0, signal: null, timedOut: false, aborted: false, outputLimitExceeded: false,
    testReport: { success: true, testResults: [{ assertionResults: assertions }] } };
  expect(readRepositoryAssessment(run)).toMatchObject({ codeRequirementsMet: true, accepted: null, documentation: null });
  expect(readRepositoryAssessment({ ...run, testReport: { success: true, testResults: [] } }).codeRequirementsMet).toBeNull();
  expect(readRepositoryAssessment({ ...run, timedOut: true }).codeRequirementsMet).toBeNull();
  expect(readRepositoryAssessment({ ...run, testReport: { success: true, testResults: [{ assertionResults: [...assertions, assertions[0]] }] } }).codeRequirementsMet).toBeNull();
  const failed = structuredClone(run); failed.exitCode = 1; failed.testReport.success = false; failed.testReport.testResults[0].assertionResults[2].status = "failed";
  expect(readRepositoryAssessment(failed)).toMatchObject({ codeRequirementsMet: false, accepted: null });
});

it("binds verification to signed delivered bytes and preserves non-delivery without grading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "fez-r01-signed-"));
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const checkout = join(root, "checkout"), key = generateSecretKey(), buyer = "a".repeat(64), task = "b".repeat(64);
  const hashes: Record<string, string> = {};
  try {
    for (const file of [...repositoryWritablePaths, "answer.md"]) {
      const delivered = join(root, "individual/delivered", file); await mkdir(join(delivered, ".."), { recursive: true });
      await writeFile(delivered, "fixture"); hashes[file] = hash("fixture");
      if (file !== "answer.md") { const target = join(checkout, file); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, "fixture"); }
    }
    const event = finalizeEvent({ kind: 47003, created_at: 1, tags: [["e", task], ["p", buyer]], content: JSON.stringify({ status: "success",
      result: { files: { "answer.md": "fixture" }, repositoryHashes: Object.fromEntries(repositoryWritablePaths.map(file => [file, hashes[file]])) } }) }, key);
    const conditions = { version: "fez-model-repository-pilot-v1", config: { taskId: "R01" }, repository: { checkouts: { individual: { path: checkout } } } };
    const report = { complete: true, conditions, conditionsSha256: hash(JSON.stringify(conditions)), arms: [
      { name: "individual", status: "delivered", artifacts: hashes, events: [{ event }], roster: { lead: getPublicKey(key), buyer }, rootTaskId: task, resultEventId: event.id },
      { name: "fixed-workflow", status: "failed" }, { name: "adaptive", status: "failed" },
    ] };
    const file = join(root, "report.json"), pack = new URL("../../../dev/experiments/coordination/", import.meta.url).pathname;
    await writeFile(file, JSON.stringify(report));
    // A valid delivery reaches baseline validation; the fixture is intentionally not the R01 baseline.
    await expect(verifyRepositoryPilot(file, checkout, join(root, "valid"), pack)).rejects.toThrow(/wrong R01 baseline/);
    event.sig = "0".repeat(128); await writeFile(file, JSON.stringify(report));
    await expect(verifyRepositoryPilot(file, checkout, join(root, "bad-signature"), pack)).rejects.toThrow(/signed result/);
    await writeFile(join(root, "individual/delivered/answer.md"), "changed");
    await expect(verifyRepositoryPilot(file, checkout, join(root, "changed"), pack)).rejects.toThrow(/artifact hash/);
    report.arms[0].status = "failed"; await writeFile(file, JSON.stringify(report));
    const result = await verifyRepositoryPilot(file, checkout, join(root, "failed"), pack);
    expect(result.arms.every(arm => arm.status === "not-delivered" && arm.accepted === null && arm.codeChecksPassed === null)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("requires the same tests to pass on repair and produce an assertion failure on baseline", () => {
  const run = (status: string, title = "retries the helper") => ({ exitCode: status === "failed" ? 1 : 0, signal: null,
    timedOut: false, aborted: false, outputLimitExceeded: false,
    testReport: { success: status === "passed", testResults: [{ assertionResults: [{ title, status, failureMessages: status === "failed" ? ["wrong Git state"] : [] }] }] } });
  expect(readRegressionEvidence(run("passed"), run("failed"))).toBe(true);
  expect(readRegressionEvidence(run("passed"), run("passed"))).toBe(false);
  expect(readRegressionEvidence(run("failed"), run("failed"))).toBe(false);
  expect(readRegressionEvidence(run("passed"), run("failed", "different tests"))).toBeNull();
  expect(readRegressionEvidence(run("passed"), run("skipped"))).toBeNull();
  expect(readRegressionEvidence(run("passed"), { ...run("failed"), testReport: null })).toBeNull();
});

it.skipIf(!process.env.FEZ_R01_TOOL_CHECKOUT)("loads evaluator-owned tests and helper controls without changing checkout source", async () => {
  const root = await mkdtemp(join(tmpdir(), "fez-r01-evaluator-"));
  const checkout = process.env.FEZ_R01_TOOL_CHECKOUT!;
  const helperPath = join(checkout, "packages/fez-acp/src/hire-delivery.ts");
  const before = await readFile(helperPath, "utf8");
  try {
    const result = await runRepositoryCheck(checkout, join(root, "control"), "delivery-tests", undefined, {
      tests: `import {it,expect} from 'vitest';import {deliverHire} from '../../fez-acp/src/hire-delivery.js';it('C1 control',()=>expect(deliverHire()).toBe('evaluator override'));`,
      helper: `export function deliverHire(){return 'evaluator override';}`,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, testReport: { success: true, numPassedTests: 1 } });
    expect(await readFile(helperPath, "utf8")).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

it.skipIf(!process.env.FEZ_R01_TOOL_CHECKOUT)("calibrates all requirements against repair, unsafe delivery and error-leak controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "fez-r01-calibration-")), checkout = process.env.FEZ_R01_TOOL_CHECKOUT!;
  const baseline = await readFile(join(checkout, "packages/fez-acp/src/hire-delivery.ts"), "utf8");
  const tests = await readFile(new URL("../../../dev/experiments/coordination/r01-acceptance.test.ts", import.meta.url), "utf8");
  const guard = '    if (git(["symbolic-ref", "--short", "HEAD"]).toString().trim() !== opts.branch) throw new Error("wrong branch");\n';
  const reference = baseline.replace('    git(["add", "-A"]);', guard + '    git(["add", "-A"]);')
    .replace('    git(["-c", "commit.gpgsign=false"', '    if (git(["diff", "--cached", "--name-only"]).length) git(["-c", "commit.gpgsign=false"');
  const unsafe = reference.replace(guard, "").replace('"push", "origin"', '"push", "--force", "origin"')
    .replace('opts.authHeader()', '(opts.authHeader(), "Authorization: Nostr cached-credential")');
  const leaking = reference.replace('} catch {', '} catch (error) {').replace(/throw new Error\(`Git[^\n]+/, 'throw error;');
  try {
    for (const [name, helper, failed] of [["reference", reference, []], ["unsafe", unsafe, ["C6", "C7", "C8"]], ["leaking", leaking, ["C2", "C4"]]] as const) {
      const run = await runRepositoryCheck(checkout, join(root, name), "delivery-tests", undefined, { tests, helper });
      const assessment = readRepositoryAssessment(run);
      expect(assessment.codeRequirementsMet, JSON.stringify(run)).toBe(name === "reference");
      for (const id of failed) expect(assessment.cases[id].passed).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(!process.env.FEZ_R01_TOOL_CHECKOUT)("keeps the baseline unaccepted despite its passing original suite and types", async () => {
  const root = await mkdtemp(join(tmpdir(), "fez-r01-evaluation-")), checkout = process.env.FEZ_R01_TOOL_CHECKOUT!;
  try {
    const pack = new URL("../../../dev/experiments/coordination/", import.meta.url).pathname;
    const report = await evaluateRepositoryCode(checkout, checkout, join(root, "evaluation"), pack);
    expect(report).toMatchObject({ codeChecksPassed: false, accepted: null, originalCoverage: true, candidateTests: true, regression: false, typecheck: true });
    expect(Object.fromEntries(Object.entries(report.requirements.cases).map(([id, row]) => [id, row.passed])))
      .toEqual({ C1: true, C2: true, C3: false, C4: true, C5: false, C6: false, C7: true, C8: false });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 45_000);
