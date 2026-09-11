import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readCandidate, scoreCandidate, type Family } from "../../../dev/experiments/coordination/benchmark.js";

const base = fileURLToPath(new URL("../../../dev/experiments/coordination/", import.meta.url));
const bytes = readFileSync(join(base, "development-pack.json"));
interface Task {
  id: string; family: Family; title: string; cluster: string; fixture: string | null;
  sources: string[]; prompt: string; acceptance: string[]; reviewerNotes: string[];
}
const pack = JSON.parse(bytes.toString("utf8")) as {
  version: string; tasks: Task[]; sources: Record<string, { text: string }>;
  fixtures: Record<string, { starter: string; reference: string; checks: string }>;
  rubrics: Record<Family, { name: string; weight: number; anchors: string[] }[]>;
  baselines: { id: string; instructions: string; sha256: string }[];
};

it("provides a complete three-family development schedule with sources and anchored rubrics", () => {
  expect(pack.version).toBe("fez-coordination-dev-1");
  expect(new Set(pack.tasks.map(t => t.id)).size).toBe(18);
  expect(new Set(pack.tasks.filter(t => t.family === "coding").map(t => t.fixture)).size).toBe(6);
  for (const family of ["coding", "writing", "combined"] as const) {
    expect(pack.tasks.filter(t => t.family === family)).toHaveLength(6);
    expect(pack.rubrics[family].reduce((sum, r) => sum + r.weight, 0)).toBeCloseTo(1);
    expect(pack.rubrics[family].every(r => r.anchors.length === 3 && r.anchors.every(Boolean))).toBe(true);
  }
  for (const task of pack.tasks) {
    expect(task.prompt.length).toBeGreaterThan(40);
    expect(task.acceptance.length).toBeGreaterThan(1);
    expect(task.reviewerNotes.length).toBeGreaterThan(0);
    expect(task.sources.length).toBeGreaterThan(0);
    for (const id of task.sources) expect(pack.sources[id]?.text.length).toBeGreaterThan(30);
    if (task.family === "writing") expect(task.fixture).toBeNull();
    else expect(pack.fixtures[task.fixture!]).toBeDefined();
  }
  const manifest = {
    candidateSha256: pack.baselines[0].sha256,
    conditionsSha256: createHash("sha256").update(bytes).digest("hex"),
    cases: pack.tasks.map(t => ({ taskId: t.id, family: t.family, trial: 0 })),
  };
  expect(scoreCandidate(manifest, [])).toMatchObject({ missing: 18, ready: false, quality: null });
  expect(new Set(pack.baselines.map(b => b.sha256)).size).toBe(3);
  for (const baseline of pack.baselines) {
    expect(readCandidate(new TextEncoder().encode(baseline.instructions)).sha256).toBe(baseline.sha256);
  }
});

it("prepares every case without copying reference answers and refuses to overwrite an attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "fez-coordination-pack-"));
  const cli = join(base, "prepare.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000 });
  try {
    for (const task of pack.tasks) {
      const attempt = join(dir, task.id);
      const prepared = run(task.id, attempt);
      expect(prepared.status, prepared.stderr).toBe(0);
      const names = readdirSync(attempt);
      expect(names.sort()).toEqual((task.fixture
        ? ["task.md", "sources.md", "case.json", "task.mjs", "acceptance.test.mjs"]
        : ["task.md", "sources.md", "case.json"]).sort());
      const metadata = JSON.parse(readFileSync(join(attempt, "case.json"), "utf8"));
      expect(metadata).toMatchObject({ taskId: task.id, family: task.family,
        packSha256: createHash("sha256").update(bytes).digest("hex") });
      for (const [name, sha256] of Object.entries(metadata.files)) {
        expect(createHash("sha256").update(readFileSync(join(attempt, name))).digest("hex")).toBe(sha256);
      }
      if (task.fixture) expect(readFileSync(join(attempt, "task.mjs"), "utf8")).toBe(pack.fixtures[task.fixture].starter);
      expect(readFileSync(join(attempt, "task.md"), "utf8")).toContain(task.prompt);
      writeFileSync(join(attempt, "answer.md"), "work to preserve");
      expect(run(task.id, attempt).status).toBe(1);
      expect(readFileSync(join(attempt, "answer.md"), "utf8")).toBe("work to preserve");
    }
    for (const args of [[], ["C01"], ["unknown", join(dir, "unused")], ["C01", join(dir, "unused"), "extra"]]) {
      const failure = run(...args);
      expect(failure.status).toBe(1);
      expect(failure.stderr).toMatch(/usage|unknown/);
    }
    expect(readdirSync(dir)).not.toContain("unused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("each repository fixture fails before repair and passes its independent checks after repair", () => {
  const dir = mkdtempSync(join(tmpdir(), "fez-coordination-fixture-"));
  try {
    for (const [id, fixture] of Object.entries(pack.fixtures)) {
      writeFileSync(join(dir, "acceptance.test.mjs"), fixture.checks);
      writeFileSync(join(dir, "task.mjs"), fixture.starter);
      const run = () => spawnSync(process.execPath, ["--test", "acceptance.test.mjs"], { cwd: dir, encoding: "utf8", timeout: 5000 });
      const broken = run();
      expect(broken.status, `${id}: starter should fail checks\n${broken.stdout}${broken.stderr}`).toBe(1);
      expect(broken.stdout).toMatch(/fail [1-9]/);
      writeFileSync(join(dir, "task.mjs"), fixture.reference);
      const fixed = run();
      expect(fixed.status, `${id}: reference failed\n${fixed.stdout}${fixed.stderr}`).toBe(0);
      expect(fixed.stdout).toMatch(/fail 0/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
