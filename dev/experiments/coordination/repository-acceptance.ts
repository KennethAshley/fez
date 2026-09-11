import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateEvent, verifyEvent } from "nostr-tools";
import { KIND_AGENT_RESULT } from "../../../src/protocol/kinds.js";
import { runRepositoryCheck, repositoryWritablePaths } from "./repository-tools.js";

const codeIds = Array.from({ length: 8 }, (_, index) => `C${index + 1}`);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
type Run = Pick<Awaited<ReturnType<typeof runRepositoryCheck>>, "exitCode" | "signal" | "timedOut" | "aborted" | "outputLimitExceeded" | "testReport">;
interface Assertion { title: string; fullName?: string; status: "passed" | "failed"; failureMessages: string[] }

function assertionsFrom(run: Run): Assertion[] | null {
  const report = run.testReport;
  if (run.timedOut || run.aborted || run.outputLimitExceeded || run.signal || ![0, 1].includes(run.exitCode ?? -1) ||
    !record(report) || !Array.isArray(report.testResults)) return null;
  const assertions: unknown[] = report.testResults.flatMap((file: unknown) => record(file) && Array.isArray(file.assertionResults) ? file.assertionResults : [null]);
  if (!assertions.length || !assertions.every(value => record(value) && typeof value.title === "string" &&
    (value.fullName === undefined || typeof value.fullName === "string") && ["passed", "failed"].includes(String(value.status)) &&
    Array.isArray(value.failureMessages) && value.failureMessages.every(message => typeof message === "string"))) return null;
  const rows = assertions as Assertion[];
  if (new Set(rows.map(row => row.fullName ?? row.title)).size !== rows.length) return null;
  const allPassed = rows.every(row => row.status === "passed");
  return report.success === allPassed && run.exitCode === (allPassed ? 0 : 1) ? rows : null;
}

/** An assertion failure on the same tests is required; compile failures, skipped tests and changed test lists prove nothing. */
export function readRegressionEvidence(repair: Run, baseline: Run): boolean | null {
  const good = assertionsFrom(repair), bad = assertionsFrom(baseline);
  if (!good || !bad || JSON.stringify(good.map(row => row.fullName ?? row.title).sort()) !==
    JSON.stringify(bad.map(row => row.fullName ?? row.title).sort())) return null;
  return good.every(row => row.status === "passed") && bad.some(row => row.status === "failed" && row.failureMessages.length > 0);
}

/** Fixed local checks are evidence; documentation and overall acceptance require separate review. */
export function readRepositoryAssessment(run: Run) {
  const result = { codeRequirementsMet: null as boolean | null, accepted: null, documentation: null,
    cases: Object.fromEntries(codeIds.map(id => [id, { passed: null as boolean | null, title: "", failureMessages: [] as string[] }])) };
  const assertions = assertionsFrom(run);
  if (!assertions) return result;
  const seen = new Set<string>();
  for (const assertion of assertions) {
    const id = assertion.title.split(" ")[0];
    if (!codeIds.includes(id) || seen.has(id)) return result;
    seen.add(id);
  }
  if (seen.size !== codeIds.length) return result;
  const allPassed = assertions.every(assertion => assertion.status === "passed");
  for (const assertion of assertions) {
    result.cases[assertion.title.split(" ")[0]] = { passed: assertion.status === "passed", title: assertion.title, failureMessages: assertion.failureMessages };
  }
  result.codeRequirementsMet = allPassed;
  return result;
}

/** Frozen local acceptance checks and regression evidence; review still decides scope, submitted coverage and prose. */
export async function evaluateRepositoryCode(checkout: string, baselineCheckout: string, directory: string, packDirectory: string) {
  const repo = await realpath(checkout), baseline = await realpath(baselineCheckout), output = resolve(directory);
  assert(output !== repo && !output.startsWith(repo + "/") && output !== baseline && !output.startsWith(baseline + "/"), "evaluation evidence must be outside checkouts");
  const helper = await readFile(join(baseline, repositoryWritablePaths[0]), "utf8");
  const originalTests = await readFile(join(baseline, repositoryWritablePaths[1]), "utf8");
  const task = await readFile(join(packDirectory, "REPOSITORY-TASK.md"), "utf8");
  assert.equal(hash(helper), "9535de70a17774e43283cbac340d3630a60c11ec4c5503d0f8b8789d03f2c104", "wrong R01 baseline helper");
  assert.equal(hash(originalTests), "4bc0ca52e804e24d4f627b574070eb162f8c9ec4e8b88d9aeca2933a3e4e837f", "wrong original coverage");
  assert.equal(hash(task), "3c9eebb9250f138ba537e5fd57afd8302a5f15726c87dded93c34d0585d19ad3", "R01 task contract changed");
  const tests = await readFile(join(packDirectory, "r01-acceptance.test.ts"), "utf8");
  await mkdir(output);
  const inputHashes = Object.fromEntries(await Promise.all(repositoryWritablePaths.map(async file => {
    const text = await readFile(join(repo, file));
    await writeFile(join(output, file.split("/").at(-1)!), text, { flag: "wx" });
    return [file, hash(text)];
  })));
  const checks: Record<string, Awaited<ReturnType<typeof runRepositoryCheck>>> = {};
  for (const [name, kind, overrides] of [
    ["acceptance", "delivery-tests", { tests }], ["original-coverage", "delivery-tests", { tests: originalTests }],
    ["candidate-tests", "delivery-tests", undefined], ["regression-baseline", "delivery-tests", { helper }], ["types", "types", undefined],
  ] as const) {
    const result = await runRepositoryCheck(repo, join(output, name), kind, undefined, overrides);
    assert.deepEqual(result.inputHashes, inputHashes, "candidate source changed during evaluation");
    checks[name] = result;
  }
  const requirements = readRepositoryAssessment(checks.acceptance);
  const passed = (run: Run) => assertionsFrom(run)?.every(row => row.status === "passed") ?? null;
  const originalCoverage = passed(checks["original-coverage"]), candidateTests = passed(checks["candidate-tests"]);
  const regression = readRegressionEvidence(checks["candidate-tests"], checks["regression-baseline"]);
  const types = checks.types;
  const typecheck = types.timedOut || types.aborted || types.outputLimitExceeded || types.signal ? null : types.exitCode === 0 ? true :
    types.exitCode === 2 && /error TS\d+:/.test(types.stdout + types.stderr) ? false : null;
  const criteria = [requirements.codeRequirementsMet, originalCoverage, candidateTests, regression, typecheck];
  const report = { version: "fez-r01-code-evaluation-v1", repo, baseline, taskSha256: hash(task), evaluatorSha256: hash(tests), inputHashes,
    requirements, originalCoverage, candidateTests, regression, typecheck,
    codeChecksPassed: criteria.includes(false) ? false : criteria.includes(null) ? null : true,
    accepted: null, documentation: null, scopeAndSubmittedCoverageReview: null, checks,
    trust: "reviewed-local-submissions; candidate code shares the test process, so this is not a hostile-miner attestation" };
  await writeFile(join(output, "evaluation.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  const rubric = task.split("## Documentation acceptance, fixed before attempts\n")[1].split("## Accepted result and comparison")[0];
  await writeFile(join(output, "review.md"), `# R01 submission review\n\nStatus: pending. Code checks: ${String(report.codeChecksPassed)}. Source hashes are in evaluation.json.\n\nReview the frozen hire-delivery.ts, hire-delivery.test.ts and README.md copies here. Confirm the submitted diff stays within the three task files, retains original test coverage, and its demonstrated regression actually invokes the same helper after rejected push. A failing baseline test alone does not establish that specific coverage.\n\nFor each D1–D8 item, record pass/fail/unavailable, the exact README passage (or its absence) and reasoning grounded in the code/check observations. Preserve disagreements for the designated human maintainer; do not rerun judges to obtain agreement.\n\n${rubric}`, { flag: "wx" });
  return report;
}

/** Verify a saved local pilot's delivered files before executing independent checks; never rewrite generation evidence. */
export async function verifyRepositoryPilot(reportPath: string, baselineCheckout: string, directory: string, packDirectory: string) {
  assert((await lstat(reportPath)).size <= 64 * 1024 * 1024, "pilot report exceeds limit");
  const bytes = await readFile(reportPath);
  assert(bytes.length <= 64 * 1024 * 1024, "pilot report exceeds limit");
  const report: unknown = JSON.parse(bytes.toString());
  assert(record(report) && report.complete === true && record(report.conditions) && Array.isArray(report.arms), "complete repository pilot required");
  assert.equal(hash(JSON.stringify(report.conditions)), report.conditionsSha256, "pilot conditions hash mismatch");
  assert(report.conditions.version === "fez-model-repository-pilot-v1" && record(report.conditions.config) && report.conditions.config.taskId === "R01" &&
    record(report.conditions.repository) && record(report.conditions.repository.checkouts), "R01 repository conditions required");
  const names = ["individual", "fixed-workflow", "adaptive"];
  assert.deepEqual(report.arms.map(arm => record(arm) ? arm.name : null), names, "invalid pilot arms");
  const base = await realpath(dirname(resolve(reportPath)));
  const inputs: { name: string; checkout: string | null; hashes: Record<string, string> | null }[] = [];
  for (const value of report.arms) {
    assert(record(value) && typeof value.name === "string" && ["delivered", "failed"].includes(String(value.status)), "invalid arm");
    if (value.status === "failed") { inputs.push({ name: value.name, checkout: null, hashes: null }); continue; }
    const declared = report.conditions.repository.checkouts[value.name];
    assert(record(declared) && typeof declared.path === "string" && record(value.artifacts) && Array.isArray(value.events) && record(value.roster), "incomplete delivery evidence");
    assert.deepEqual(Object.keys(value.artifacts).sort(), [...repositoryWritablePaths, "answer.md"].sort(), "invalid delivered file set");
    const checkout = await realpath(declared.path), hashes: Record<string, string> = {};
    for (const file of [...repositoryWritablePaths, "answer.md"]) {
      const path = join(base, value.name, "delivered", file), stat = await lstat(path);
      assert(stat.isFile() && stat.nlink === 1 && stat.size <= 131_072 && await realpath(path) === path, "invalid delivered file");
      assert.equal(hash(await readFile(path)), value.artifacts[file], "delivered artifact hash mismatch");
      if (file !== "answer.md") {
        hashes[file] = hash(await readFile(join(checkout, file)));
        assert.equal(hashes[file], value.artifacts[file], "checkout differs from delivered source");
      }
    }
    const row = value.events.find(row => record(row) && record(row.event) && row.event.id === value.resultEventId);
    assert(record(row) && record(row.event), "invalid signed result");
    const { id, sig } = row.event;
    assert(typeof id === "string" && typeof sig === "string" && validateEvent(row.event), "invalid signed result");
    const event = { ...row.event, id, sig }, roster = value.roster;
    assert(verifyEvent(event), "invalid signed result");
    assert(event.kind === KIND_AGENT_RESULT && event.pubkey === roster.lead &&
      event.tags.some(tag => tag[0] === "e" && tag[1] === value.rootTaskId) &&
      event.tags.some(tag => tag[0] === "p" && tag[1] === roster.buyer), "result is not the lead's root delivery");
    const content: unknown = JSON.parse(event.content);
    assert(record(content) && content.status === "success" && record(content.result) && record(content.result.files), "unsuccessful signed result");
    assert.deepEqual(content.result.repositoryHashes, hashes, "signed source hashes differ");
    assert(typeof content.result.files["answer.md"] === "string" && hash(content.result.files["answer.md"]) === value.artifacts["answer.md"], "signed answer differs");
    inputs.push({ name: value.name, checkout, hashes });
  }
  await mkdir(resolve(directory));
  const summary = { version: "fez-r01-pilot-verification-v1", sourceReportSha256: hash(bytes), accepted: null,
    arms: [] as { name: string; status: string; codeChecksPassed: boolean | null; accepted: null; evaluation: string | null }[] };
  for (const input of inputs) {
    const evaluation = input.checkout ? await evaluateRepositoryCode(input.checkout, baselineCheckout, join(directory, input.name), packDirectory) : null;
    if (evaluation) assert.deepEqual(evaluation.inputHashes, input.hashes, "source changed after signed-delivery validation");
    summary.arms.push({ name: input.name, status: evaluation ? "evaluated" : "not-delivered", codeChecksPassed: evaluation?.codeChecksPassed ?? null,
      accepted: null, evaluation: evaluation ? `${input.name}/evaluation.json` : null });
    await writeFile(join(directory, "verification.json"), JSON.stringify(summary, null, 2) + "\n");
  }
  assert.equal(hash(await readFile(reportPath)), summary.sourceReportSha256, "generation evidence changed during verification");
  return summary;
}
