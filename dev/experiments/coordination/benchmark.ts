import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function readCandidate(bytes: Uint8Array): { sha256: string; instructions: string } {
  assert(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 32768,
    "candidate must be 1–32768 bytes");
  const instructions = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  assert(instructions.trim().length > 0 && !instructions.includes("\u0000"), "invalid instructions");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), instructions };
}

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
  costBasis: Assessment["costBasis"];
  totalElapsedMs: number | null;
  humanInterventions: number | null;
}

const families: Family[] = ["coding", "writing", "combined"];
const measurements = ["elapsedMs", "costMicrousd", "humanInterventions"] as const;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertHash(value: unknown, label: string): void {
  assert(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${label} must be a lowercase SHA-256 hash`);
}

function assertInteger(value: unknown, label: string): void {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    `${label} must be a nonnegative safe integer`);
}

function caseKey(c: Case): string {
  assertRecord(c, "case");
  assert(typeof c.taskId === "string" && c.taskId.trim().length > 0, "taskId must be nonempty text");
  assert(families.includes(c.family), "family must be coding, writing or combined");
  assertInteger(c.trial, "trial");
  return JSON.stringify([c.taskId, c.family, c.trial]);
}

// Inputs can come from local JSON; TypeScript declarations do not validate that boundary.
export function scoreCandidate(manifest: CandidateManifest, rows: Assessment[]): CandidateReport {
  assertRecord(manifest, "manifest");
  assertHash(manifest.candidateSha256, "candidateSha256");
  assertHash(manifest.conditionsSha256, "conditionsSha256");
  assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, "cases must be a nonempty array");
  assert(Array.isArray(rows), "rows must be an array");

  const expected = new Set<string>();
  const tasks = new Map<string, { family: Family; trials: number[] }>();
  for (const c of manifest.cases) {
    const key = caseKey(c);
    assert(!expected.has(key), `duplicate manifest case: ${key}`);
    expected.add(key);
    const task = tasks.get(c.taskId);
    if (task) {
      assert(task.family === c.family, `task ${c.taskId} has inconsistent families`);
      task.trials.push(c.trial);
    } else {
      tasks.set(c.taskId, { family: c.family, trials: [c.trial] });
    }
  }
  assert(families.every(f => [...tasks.values()].some(t => t.family === f)), "schedule must include all three families");
  const trialSets = new Set([...tasks.values()].map(t => JSON.stringify(t.trials.sort((a, b) => a - b))));
  assert(trialSets.size === 1, "every task must have the same trial set");
  const keys = [...expected].sort();
  const scheduleSha256 = createHash("sha256").update(JSON.stringify(keys)).digest("hex");

  const byCase = new Map<string, Assessment>();
  for (const row of rows) {
    const key = caseKey(row);
    assert(expected.has(key), `unexpected assessment case: ${key}`);
    assert(!byCase.has(key), `duplicate assessment: ${key}`);
    assert(row.candidateSha256 === manifest.candidateSha256, `candidate mismatch: ${key}`);
    assert(row.conditionsSha256 === manifest.conditionsSha256, `conditions mismatch: ${key}`);
    assert(row.status === "assessed" || row.status === "unavailable", `invalid assessment status: ${key}`);
    if (row.status === "assessed") {
      assert(typeof row.quality === "number" && Number.isFinite(row.quality) && row.quality >= 0 && row.quality <= 1,
        `quality must be between 0 and 1: ${key}`);
      assert(typeof row.accepted === "boolean" && typeof row.withinLimits === "boolean",
        `assessed acceptance and limits must be booleans: ${key}`);
    } else {
      assert(row.quality === null && row.accepted === null && row.withinLimits === null,
        `unavailable grades must be null: ${key}`);
    }
    for (const field of measurements) {
      if (row[field] !== null) assertInteger(row[field], `${field}: ${key}`);
    }
    assert(row.costMicrousd === null ? row.costBasis === "unknown" :
      row.costBasis === "measured" || row.costBasis === "estimated", `costBasis does not match cost: ${key}`);
    byCase.set(key, row);
  }

  // Canonical order keeps floating-point aggregation reproducible when rows are shuffled.
  const ordered = keys.map(key => byCase.get(key)).filter((row): row is Assessment => row !== undefined);
  const missing = expected.size - rows.length;
  const unavailable = rows.filter(r => r.status === "unavailable").length;
  const ready = missing === 0 && unavailable === 0;
  const byFamily: Record<Family, number> | null = ready ? { coding: 0, writing: 0, combined: 0 } : null;
  if (byFamily) {
    for (const family of families) {
      const members = ordered.filter(r => r.family === family);
      byFamily[family] = members.reduce((sum, r) => sum + (r.accepted && r.withinLimits ? r.quality! : 0), 0) / members.length;
    }
  }
  const quality = byFamily ? families.reduce((sum, f) => sum + byFamily[f], 0) / families.length : null;
  function total(field: typeof measurements[number]): number | null {
    if (!ready || ordered.some(r => r[field] === null)) return null;
    const sum = ordered.reduce((sum, r) => sum + r[field]!, 0);
    assertInteger(sum, `total ${field}`);
    return sum;
  }
  const totalCostMicrousd = total("costMicrousd");
  return {
    candidateSha256: manifest.candidateSha256, conditionsSha256: manifest.conditionsSha256, scheduleSha256,
    ready, missing, unavailable, byFamily, quality, totalCostMicrousd,
    costBasis: totalCostMicrousd === null ? "unknown" : rows.some(r => r.costBasis === "estimated") ? "estimated" : "measured",
    totalElapsedMs: total("elapsedMs"), humanInterventions: total("humanInterventions"),
  };
}

export function compareCandidates(inputs: { manifest: CandidateManifest; rows: Assessment[] }[]): CandidateReport[] {
  assert(Array.isArray(inputs) && inputs.length >= 2, "comparison requires at least two candidates");
  const reports = inputs.map(input => {
    assertRecord(input, "comparison entry");
    return scoreCandidate(input.manifest, input.rows);
  });
  assert(new Set(reports.map(r => r.candidateSha256)).size === reports.length, "candidate hashes must be distinct");
  assert(reports.every(r => r.conditionsSha256 === reports[0].conditionsSha256), "comparison conditions must match");
  assert(reports.every(r => r.scheduleSha256 === reports[0].scheduleSha256), "comparison schedules must match");
  for (const report of reports) {
    assert(report.ready,
      `incomplete candidate ${report.candidateSha256}: ${report.missing} missing, ${report.unavailable} unavailable`);
  }
  // Equal quality remains a tie; hashes only make its display order deterministic.
  return reports.sort((a, b) => b.quality! - a.quality! || (a.candidateSha256 < b.candidateSha256 ? -1 : 1));
}
