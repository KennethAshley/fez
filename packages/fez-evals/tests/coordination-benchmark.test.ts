import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";
import {
  readCandidate, scoreCandidate, compareCandidates,
  type Case, type Family, type CandidateManifest, type Assessment,
} from "../../../dev/experiments/coordination/benchmark.js";

it("identifies exact instruction bytes without interpreting frontmatter or stripping a BOM", () => {
  const instructions = "\ufeff---\nmodel: arbitrary\n---\nAsk a reviewer.\n";
  const bytes = new TextEncoder().encode(instructions);
  const candidate = readCandidate(bytes);
  expect(candidate.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(candidate.instructions).toBe(instructions);
  expect(readCandidate(new TextEncoder().encode(instructions + " ")).sha256)
    .not.toBe(candidate.sha256);
  expect(readCandidate(new Uint8Array(32768).fill(65)).instructions).toHaveLength(32768);
});

it("refuses empty, oversized, invalid UTF-8 and NUL-bearing instructions", () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode(" \n\ufeff"),
    new Uint8Array(32769).fill(65), new Uint8Array([0xff]),
    new Uint8Array([0xe2, 0x82]), new TextEncoder().encode("hello\u0000world")]) {
    expect(() => readCandidate(bytes)).toThrow();
  }
});

// Synthetic assessments; these are not evidence from agent executions.
function fixture(candidateSha256 = "a".repeat(64), quality = 0.9) {
  const families: Family[] = ["coding", "writing", "combined"];
  const manifest: CandidateManifest = {
    candidateSha256, conditionsSha256: "c".repeat(64),
    cases: families.map(family => ({ taskId: family, family, trial: 0 })),
  };
  const rows: Assessment[] = manifest.cases.map(c => ({
    ...c, candidateSha256, conditionsSha256: manifest.conditionsSha256,
    status: "assessed", quality, accepted: true, withinLimits: true,
    elapsedMs: 1000, costMicrousd: 10000, costBasis: "measured", humanInterventions: 0,
  }));
  return { manifest, rows };
}

it("reports quality separately from spending, time and human intervention", () => {
  const { manifest, rows } = fixture();
  expect(scoreCandidate(manifest, rows)).toMatchObject({
    ready: true, missing: 0, unavailable: 0,
    byFamily: { coding: 0.9, writing: 0.9, combined: 0.9 },
    totalCostMicrousd: 30000, costBasis: "measured", totalElapsedMs: 3000, humanInterventions: 0,
  });
  const expensive = rows.map(r => ({ ...r, costMicrousd: 90000, elapsedMs: 2000, humanInterventions: 1 }));
  expect(scoreCandidate(manifest, expensive).quality).toBeCloseTo(0.9);
  expect(scoreCandidate(manifest, expensive)).toMatchObject({
    totalCostMicrousd: 270000, totalElapsedMs: 6000, humanInterventions: 3,
  });
});

it.each(["accepted", "withinLimits"] as const)("counts failed %s as zero, keeping it in the denominator", field => {
  const { manifest, rows } = fixture();
  rows[0][field] = false;
  const report = scoreCandidate(manifest, rows);
  expect(report.ready).toBe(true);
  expect(report.byFamily?.coding).toBe(0);
  expect(report.quality).toBeCloseTo(0.6);
});

it("withholds quality and totals for missing or unavailable assessments", () => {
  const { manifest, rows } = fixture();
  expect(scoreCandidate(manifest, rows.slice(1))).toMatchObject({
    ready: false, missing: 1, unavailable: 0, quality: null, byFamily: null,
    totalCostMicrousd: null, costBasis: "unknown", totalElapsedMs: null, humanInterventions: null,
  });
  rows[0] = { ...rows[0], status: "unavailable", quality: null, accepted: null, withinLimits: null };
  expect(scoreCandidate(manifest, rows)).toMatchObject({
    ready: false, missing: 0, unavailable: 1, quality: null, byFamily: null,
    totalCostMicrousd: null, costBasis: "unknown", totalElapsedMs: null, humanInterventions: null,
  });
});

it("weights families equally even with extra coding tasks and repeated trials", () => {
  const { manifest, rows } = fixture();
  rows[0].quality = 0;
  rows[1].quality = 0.6;
  rows[2].quality = 0.9;
  const extra = { ...rows[0], taskId: "second-code", quality: 1 };
  const repeated = [...rows, extra].flatMap(r => [r, { ...r, trial: 1 }]);
  manifest.cases = repeated.map(({ taskId, family, trial }) => ({ taskId, family, trial }));
  const report = scoreCandidate(manifest, repeated);
  expect(report.byFamily).toEqual({ coding: 0.5, writing: 0.6, combined: 0.9 });
  expect(report.quality).toBeCloseTo(2 / 3);
});

it("preserves unknown measurements and labels any estimated cost", () => {
  const { manifest, rows } = fixture();
  rows[0].costBasis = "estimated";
  expect(scoreCandidate(manifest, rows).costBasis).toBe("estimated");
  rows[1] = { ...rows[1], costMicrousd: null, costBasis: "unknown", elapsedMs: null, humanInterventions: null };
  expect(scoreCandidate(manifest, rows)).toMatchObject({
    ready: true, totalCostMicrousd: null, costBasis: "unknown", totalElapsedMs: null, humanInterventions: null,
  });
  expect(scoreCandidate(manifest, rows).quality).toBeCloseTo(0.9);
  expect(scoreCandidate(manifest, rows.map(r => ({
    ...r, costMicrousd: 0, costBasis: "measured", elapsedMs: 0, humanInterventions: 0,
  })))).toMatchObject({ totalCostMicrousd: 0, costBasis: "measured", totalElapsedMs: 0, humanInterventions: 0 });
});

it("rejects invalid manifests, duplicate cases, missing families and ragged trial schedules", () => {
  const { manifest, rows } = fixture();
  const invalidCases: unknown[] = [
    [], null, {}, manifest.cases.slice(1), [...manifest.cases, manifest.cases[0]],
    [...manifest.cases, { ...manifest.cases[0], trial: 1 }],
    [...manifest.cases, { ...manifest.cases[0], family: "writing", trial: 1 }],
    ...[{ taskId: " " }, { taskId: 3 }, { family: "other" }, { trial: -1 }, { trial: 0.5 },
      { trial: Number.MAX_SAFE_INTEGER + 1 }].map(patch => [{ ...manifest.cases[0], ...patch }, ...manifest.cases.slice(1)]),
    [null, ...manifest.cases.slice(1)],
  ];
  for (const cases of invalidCases) {
    expect(() => scoreCandidate({ ...manifest, cases } as CandidateManifest, rows)).toThrow();
  }
  for (const bad of [null, [], {}, { ...manifest, candidateSha256: "A".repeat(64) },
    { ...manifest, conditionsSha256: "c".repeat(63) }, { ...manifest, candidateSha256: ["a".repeat(64)] }]) {
    expect(() => scoreCandidate(bad as CandidateManifest, rows)).toThrow();
  }
});

it("rejects extra, duplicate or mismatched assessments", () => {
  const { manifest, rows } = fixture();
  for (const bad of [null, {}, [...rows, rows[0]],
    ...[{ taskId: "extra" }, { family: "writing" }, { trial: 1 }, { candidateSha256: "b".repeat(64) },
      { conditionsSha256: "d".repeat(64) }].map(patch => [{ ...rows[0], ...patch }, ...rows.slice(1)]),
    [null, ...rows.slice(1)]]) {
    expect(() => scoreCandidate(manifest, bad as Assessment[])).toThrow();
  }
});

it("rejects malformed grades, statuses and cost declarations instead of silently scoring them", () => {
  const { manifest, rows } = fixture();
  const patches: Record<string, unknown>[] = [
    ...[NaN, Infinity, -0.1, 1.1, null, "0.9"].map(quality => ({ quality })),
    { accepted: null }, { accepted: 1 }, { withinLimits: "true" }, { status: "pending" },
    { status: "unavailable" }, { status: "unavailable", quality: null, accepted: null, withinLimits: true },
    { costBasis: "unknown" }, { costBasis: "invoice" }, { costMicrousd: null },
  ];
  for (const patch of patches) {
    expect(() => scoreCandidate(manifest, [{ ...rows[0], ...patch } as Assessment, ...rows.slice(1)])).toThrow();
  }
});

it.each(["elapsedMs", "costMicrousd", "humanInterventions"] as const)("rejects invalid or overflowing %s", field => {
  const { manifest, rows } = fixture();
  for (const invalid of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
    expect(() => scoreCandidate(manifest, [{ ...rows[0], [field]: invalid } as Assessment, ...rows.slice(1)])).toThrow();
  }
  rows.forEach(r => { r[field] = Number.MAX_SAFE_INTEGER; });
  expect(() => scoreCandidate(manifest, rows)).toThrow();
});

it("ranks matched candidates by quality with stable display order for ties", () => {
  const best = fixture("b".repeat(64), 1);
  const tied = fixture("d".repeat(64), 1);
  tied.rows.forEach(r => { r.costMicrousd = 0; });
  const comparison = compareCandidates([tied, fixture(), best]);
  expect(comparison.map(r => r.candidateSha256)).toEqual(["b".repeat(64), "d".repeat(64), "a".repeat(64)]);
  expect(comparison[0].quality).toBe(comparison[1].quality);
});

it("requires at least two distinct candidates and complete matched schedules and conditions", () => {
  const a = fixture();
  const b = fixture("b".repeat(64));
  const otherConditions = fixture("b".repeat(64));
  otherConditions.manifest.conditionsSha256 = "d".repeat(64);
  otherConditions.rows.forEach(r => { r.conditionsSha256 = "d".repeat(64); });
  const otherSchedule = fixture("b".repeat(64));
  otherSchedule.manifest.cases[0].taskId = "different-code";
  otherSchedule.rows[0].taskId = "different-code";
  const unavailable = fixture("b".repeat(64));
  unavailable.rows[0] = { ...unavailable.rows[0], status: "unavailable", quality: null, accepted: null, withinLimits: null };
  for (const invalid of [null, {}, [], [a], [a, a], [null, b], [a, { manifest: b.manifest }],
    [a, { ...b, rows: b.rows.slice(1) }], [a, unavailable], [a, otherConditions], [a, otherSchedule]]) {
    expect(() => compareCandidates(invalid as { manifest: CandidateManifest; rows: Assessment[] }[])).toThrow();
  }
});

it("makes reports and schedule identity independent of input ordering", () => {
  const { manifest, rows } = fixture();
  const extended = [rows[0], { ...rows[0], taskId: "coding-2", quality: 0.3 },
    { ...rows[0], taskId: "coding-3", quality: 0.1 }, ...rows.slice(1)];
  manifest.cases = extended.map(({ taskId, family, trial }): Case => ({ taskId, family, trial }));
  const before = structuredClone({ manifest, rows: extended });
  const report = scoreCandidate(manifest, extended);
  expect(scoreCandidate({ ...manifest, cases: [...manifest.cases].reverse() }, [...extended].reverse())).toEqual(report);
  expect({ manifest, rows: extended }).toEqual(before);
  expect(report.scheduleSha256).toMatch(/^[0-9a-f]{64}$/);
  const renamed = manifest.cases.map(c => ({ ...c, taskId: `${c.taskId}-v2` }));
  expect(scoreCandidate({ ...manifest, cases: renamed }, extended.map(r => ({ ...r, taskId: `${r.taskId}-v2` })))
    .scheduleSha256).not.toBe(report.scheduleSha256);
});

it("runs the report CLI and rejects incomplete, malformed or missing input without printing a ranking", () => {
  const dir = mkdtempSync(join(tmpdir(), "fez-coordination-test-"));
  const path = join(dir, "synthetic.json");
  const source = fileURLToPath(new URL("../../../dev/experiments/coordination/report.ts", import.meta.url));
  const cli = join(dir, "report.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000 });
  try {
    buildSync({ entryPoints: [source], outfile: cli, bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "silent" });
    const input = [fixture(), fixture("b".repeat(64), 1)];
    writeFileSync(path, JSON.stringify(input));
    const success = run(path);
    expect(success.status, success.stderr).toBe(0);
    expect(success.stderr).toBe("");
    const reports = JSON.parse(success.stdout);
    expect(reports.map((r: { candidateSha256: string }) => r.candidateSha256))
      .toEqual(["b".repeat(64), "a".repeat(64)]);
    expect(reports[0]).toMatchObject({ quality: 1, totalCostMicrousd: 30000, ready: true });
    input[1].rows.pop();
    for (const [contents, error] of [[JSON.stringify(input), /incomplete/], ["{", /JSON/], ["{}", /array/]] as const) {
      writeFileSync(path, contents);
      const failure = run(path);
      expect(failure.status).toBe(1);
      expect(failure.stdout).toBe("");
      expect(failure.stderr).toMatch(error);
    }
    for (const args of [[], [path, "extra"], [join(dir, "missing.json")]]) {
      const failure = run(...args);
      expect(failure.status).toBe(1);
      expect(failure.stdout).toBe("");
      expect(failure.stderr).toMatch(/usage|ENOENT/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
