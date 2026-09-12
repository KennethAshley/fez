# Coordination Benchmark Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Execute inline; parallel agents are unnecessary for these dependent tasks.

**Goal:** Build a local, deterministic tool that identifies exact coordinator instruction bytes and compares complete validator-assessed benchmark schedules without conflating quality and cost.

**Architecture:** Keep the experiment under `dev/experiments/coordination/`, using Node standard-library functions and the existing Fez eval suite. This utility processes explicitly supplied local assessment files; it neither verifies real-world outcomes nor runs candidate instructions. Production market/validator integration remains in the Bazaar extension and is outside this first plan.

**Tech Stack:** TypeScript, Node built-ins, existing Vitest. No new dependencies.

**Spec:** [Coordination miners design](../specs/2026-09-10-coordination-miners-design.md), specifically “First miner submission” and “Evaluation contract.”

## Global Constraints

- Coordination miners are the selected track; the existing app's `@fez` is the product reference.
- One candidate is non-empty UTF-8 Markdown, at most 32,768 bytes, identified by SHA-256 of exact bytes. No NULs or interpreted frontmatter.
- Three families: `coding`, `writing`, `combined`; equal family weight. No reward bonus for delegation, spending, stake, or message count.
- Missing assessments or evaluator unavailability withhold a comparative score. Assessed candidate failures count as zero.
- All compared candidates must have identical declared conditions and the same task/trial schedule. Hashes identify these declarations; they do not independently attest to honest execution.
- No inference calls, model spending, network connections, wallet operations, chain weights, or installation changes.
- No copying of private app records. Test with generated, clearly labeled fixture assessments.
- Do not commit unrelated working-tree changes. No dependency on a sibling checkout is introduced.

## File map

| File | Responsibility |
| --- | --- |
| `dev/experiments/coordination/benchmark.ts` | Candidate parsing, assessment validation, complete-schedule scoring and comparison |
| `dev/experiments/coordination/report.ts` | Read explicitly supplied local JSON, print result, exit nonzero on invalid/incomplete comparison |
| `dev/experiments/coordination/README.md` | Input shape, invocation, interpretation and trust limits |
| `packages/fez-evals/tests/coordination-benchmark.test.ts` | Candidate, scoring, schedule and comparison regressions |

## Task 1: Identify immutable coordinator instructions

**Files:** Create `benchmark.ts` and `coordination-benchmark.test.ts` at the paths above.

**Interfaces:** Produces `readCandidate(bytes: Uint8Array): { sha256: string; instructions: string }`.

- [x] Add the following regression cases before implementation:

```typescript
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readCandidate } from "../../../dev/experiments/coordination/benchmark.js";

it("identifies the exact instructions without interpreting frontmatter", () => {
  const bytes = new TextEncoder().encode("---\nmodel: arbitrary\n---\nAsk a reviewer.\n");
  const candidate = readCandidate(bytes);
  expect(candidate.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(candidate.instructions).toBe(new TextDecoder().decode(bytes));
  expect(readCandidate(new TextEncoder().encode(candidate.instructions + " ")).sha256)
    .not.toBe(candidate.sha256);
});

it("refuses empty, oversized, invalid UTF-8 and NUL-bearing instructions", () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode(" \n"),
    new Uint8Array(32769).fill(65), new Uint8Array([0xff]),
    new TextEncoder().encode("hello\u0000world")]) {
    expect(() => readCandidate(bytes)).toThrow();
  }
});
```

- [x] Run `npm test --prefix packages/fez-evals -- tests/coordination-benchmark.test.ts`; confirm failure from the missing implementation.
- [x] Implement the candidate function with standard-library validation:

```typescript
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function readCandidate(bytes: Uint8Array) {
  assert(bytes.length > 0 && bytes.length <= 32768, "candidate must be 1–32768 bytes");
  const instructions = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  assert(instructions.trim().length > 0 && !instructions.includes("\u0000"), "invalid instructions");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), instructions };
}
```

- [x] Rerun the test and confirm both cases pass. Add a boundary assertion accepting exactly 32,768 valid bytes.

## Task 2: Score complete, matched assessment schedules

**Files:** Extend the same implementation and test files.

**Interfaces:** Consumes candidate hashes from task 1. Produces these shared types and `scoreCandidate(manifest: CandidateManifest, rows: Assessment[]): CandidateReport` plus `compareCandidates(inputs: { manifest: CandidateManifest; rows: Assessment[] }[]): CandidateReport[]`.

```typescript
export type Family = "coding" | "writing" | "combined";
export interface Case { taskId: string; family: Family; trial: number }
export interface CandidateManifest {
  candidateSha256: string;
  conditionsSha256: string;
  cases: Case[];
}
export interface Assessment extends Case {
  candidateSha256: string;
  conditionsSha256: string;
  status: "assessed" | "unavailable";
  quality: number | null;
  accepted: boolean | null;
  withinLimits: boolean | null;
  elapsedMs: number | null;
  costMicrousd: number | null;
  costBasis: "measured" | "estimated" | "unknown";
  humanInterventions: number | null;
}
export interface CandidateReport {
  candidateSha256: string;
  conditionsSha256: string;
  scheduleSha256: string;
  ready: boolean;
  missing: number;
  unavailable: number;
  byFamily: Record<Family, number> | null;
  quality: number | null;
  totalCostMicrousd: number | null;
  costBasis: "measured" | "estimated" | "unknown";
  totalElapsedMs: number | null;
  humanInterventions: number | null;
}
```

- [x] Add a three-family, one-trial fixture using a 64-character candidate hash and conditions hash. Keep fixture construction in this one test file:

```typescript
// Extend the existing benchmark import with these values and types.
import { scoreCandidate, compareCandidates, type Case, type Family,
  type CandidateManifest, type Assessment } from "../../../dev/experiments/coordination/benchmark.js";

const cases: Case[] = ["coding", "writing", "combined"].map(family => ({
  taskId: family, family: family as Family, trial: 0,
}));
const manifest: CandidateManifest = {
  candidateSha256: "a".repeat(64), conditionsSha256: "c".repeat(64), cases,
};
const rows = (): Assessment[] => cases.map(c => ({
  ...c, candidateSha256: manifest.candidateSha256, conditionsSha256: manifest.conditionsSha256,
  status: "assessed", quality: 0.9, accepted: true, withinLimits: true,
  elapsedMs: 1000, costMicrousd: 10000, costBasis: "measured", humanInterventions: 0,
}));

it("scores quality independently of cost and refuses incomplete results", () => {
  const complete = rows();
  expect(scoreCandidate(manifest, complete).quality).toBeCloseTo(0.9);
  expect(scoreCandidate(manifest, complete.map(r => ({ ...r, costMicrousd: 90000 }))).quality)
    .toBeCloseTo(0.9);
  expect(scoreCandidate(manifest, complete.slice(1)).quality).toBeNull();
  expect(scoreCandidate(manifest, [{ ...complete[0]!, accepted: false }, ...complete.slice(1)]).quality)
    .toBeCloseTo(0.6);
  expect(() => scoreCandidate(manifest, [...complete, complete[0]!])).toThrow();
});

it("does not compare candidates evaluated under different conditions", () => {
  const second = { ...manifest, candidateSha256: "b".repeat(64), conditionsSha256: "d".repeat(64) };
  expect(() => compareCandidates([
    { manifest, rows: rows() },
    { manifest: second, rows: rows().map(r => ({ ...r, candidateSha256: second.candidateSha256,
      conditionsSha256: second.conditionsSha256 })) },
  ])).toThrow();
});
```

- [x] Run the targeted suite and confirm failure for missing scoring functions.
- [x] Implement validation before aggregation, using `node:assert/strict`. Require both hashes to match `/^[0-9a-f]{64}$/`; require a nonempty case list with all three families; require nonempty task IDs, allowed families, and nonnegative safe-integer trial numbers. One task ID must map to one family. Reject duplicate manifest cases. Require a rectangular schedule: every task has the same declared trial set.
- [x] Build case keys with `JSON.stringify([taskId, family, trial])`; hash the sorted case keys to produce `scheduleSha256`. Validate each assessment against the exact expected case, candidate and conditions. Reject extra cases, duplicate assessments and mismatches rather than ignoring them.
- [x] Validate assessed quality as finite and in `[0, 1]`, with boolean `accepted` and `withinLimits`. Require unavailable rows to have null quality/acceptance/limits. Validate every non-null measurement as a nonnegative safe integer. Permit null measurements without inventing zero. A null cost must have `costBasis: "unknown"`; a numeric cost must be measured or estimated. Reject unknown statuses and cost bases.
- [x] Implement the score and reporting rules with the following algorithm; all input checks above occur first:

```typescript
const mean = (values: number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
const eligible = (r: Assessment) => r.accepted && r.withinLimits ? r.quality! : 0;
const missing = manifest.cases.length - rows.length;
const unavailable = rows.filter(r => r.status === "unavailable").length;
const ready = missing === 0 && unavailable === 0;
const families: Family[] = ["coding", "writing", "combined"];
const byFamily = ready ? Object.fromEntries(families.map(family => [
  family, mean(rows.filter(r => r.family === family).map(eligible)),
])) as Record<Family, number> : null;
const quality = byFamily ? mean(families.map(family => byFamily[family])) : null;
```

For measurement totals, return null if the schedule is not ready or any component is null. Otherwise sum and require the result to remain a safe integer. Report cost basis as unknown when the total is null; otherwise estimated if any component is estimated, measured only if all are measured. `totalElapsedMs` is the sum of attempt durations, not the wall-clock duration of concurrently executed experiments.

`compareCandidates` requires at least two distinct candidate hashes. Compute every report, require identical conditions and schedule hashes, and require every report to be ready before returning an ordering. Sort by descending quality, then candidate hash for stable display; equal quality is still a tie and the hash tiebreak is not a reward distinction.

- [x] Add cases for an unavailable grader, a failed limit check, a missing family, a ragged trial schedule, duplicate task/trial, extra rows, mismatched candidate, non-finite quality, negative/unsafe measurements, unknown measurement totals, and estimated-cost labeling. Add a schedule with two coding tasks and one task in each other family; verify the three families still contribute equally.
- [x] Rerun the targeted suite. Do not proceed until these cases pass.

## Task 3: Make the local comparison runnable and explain its limits

**Files:** Create `report.ts` and `README.md`; extend the same test file for input/exit checks.

**Interfaces:** Consumes `compareCandidates`. Input is one explicitly named JSON file containing the array of `{manifest, rows}` values defined in task 2. Output is JSON candidate reports. Runtime validation in task 2 rejects malformed input; static casts in this local wrapper do not authorize trusting the contents.

- [x] Create this wrapper:

```typescript
import { readFile } from "node:fs/promises";
import { compareCandidates } from "./benchmark.ts";

try {
  const [input, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error("usage: report.ts <assessment-file.json>");
  const parsed = JSON.parse(await readFile(input, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("assessment file must contain a comparison array");
  process.stdout.write(JSON.stringify(compareCandidates(parsed), null, 2) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
```

- [x] Extend the test to generate a valid two-candidate comparison JSON in an OS temporary directory, invoke the wrapper with the local Node runtime's TypeScript support, and assert exit zero with the expected quality ranking. Assert nonzero for an incomplete comparison and for malformed JSON. Clean up only the test's own temporary directory. If this runtime lacks native TypeScript support, invoke the existing test runner for verification and compile the two files with the already installed TypeScript toolchain for the documented CLI; do not install a new runner.
- [x] Document the validated invocation, the exact manifest/assessment shapes from task 2, and a generated fixture example with candidate hashes `a…a` and `b…b` and conditions hash `c…c`. Label all fixture assessments synthetic. State that this tool checks schedule/scoring integrity, not task correctness, payment, authorship, or actual resource enforcement. Real validator assessments require the controlled runner in the next implementation stage.
- [x] Run `npm test --prefix packages/fez-evals -- tests/coordination-benchmark.test.ts` and the documented wrapper command against the generated fixture.
- [x] Run root `npx tsc --noEmit` and `npm run evals`. Typecheck the new experiment files explicitly because root `tsconfig.json` includes `src` only. Use `npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions dev/experiments/coordination/benchmark.ts dev/experiments/coordination/report.ts`. Report any existing suite failures separately; an isolated rerun does not make a failed full run clean.
- [x] Review the diff, then commit only the four planned files if integration is requested. No mining descriptor, app persona, wallet, event kind, or reward configuration belongs in this commit.

## Completion evidence

The deliverable is a reproducible local comparison of fixture assessments with exact candidate IDs, explicit conditions/schedule IDs, equal-family quality, truthful unknown/estimated costs, and failure on incomplete comparisons. It provides no evidence yet that coordination is better. The next deliverable is the actual public development task pack and controlled Fez execution runner described in the spec.

## Plan review

Candidate format and byte identity are covered by task 1. Acceptance, resource-limit outcomes, metric validation, matched schedules, missing assessments and comparison fairness are covered by task 2. Runnable reporting, trust limits and repository verification are covered by task 3. Real task grading, handoff execution, dataset export, submission authentication, chain rewards and `@fez` adoption are explicitly outside this first implementation scope.


## Execution record — 2026-09-10

All three tasks are implemented in the four planned files. Changes remain local and uncommitted; no integration was requested. No application, wallet or subnet behavior was changed.

Verification:

- Candidate tests first failed because the implementation was missing, then passed. Scoring tests first failed for missing functions, then passed. The CLI test first failed for the missing entry point, then passed.
- Targeted suite: 18 tests passed.
- Full `npm run evals`: 159 test files passed, one skipped; 1,502 tests passed, one skipped; exit 0. Local relay/subprocess tests ran with loopback access. Log: `/private/tmp/fez-coordination-evals-20260910.log`.
- Root `npx tsc --noEmit`: passed.
- Explicit strict typecheck of the experiment and its test file: passed.
- README synthetic comparison: both the native Node 24.20.0 command and bundled command produced the expected ranking; disposable inputs/build output were removed.
- Reviewed the implementation and test changes; whitespace checks passed.

Small execution adjustments:

- Removed the redundant `--run` from targeted commands because the package test script already supplies it, and this Vitest version rejects duplicate options.
- The subprocess regression test uses the repository's installed esbuild to compile the CLI, keeping that test compatible with the repository's Node 20 baseline. The native TypeScript invocation was verified separately on Node 24.20.0. No dependency was added.
- Canonically order assessment rows before averaging so shuffling input cannot change floating-point results.

These checks establish scoring and input integrity for synthetic assessments only. They do not establish an advantage from delegation. Next stage: real task cases and acceptance rubrics, followed by the controlled runner.
