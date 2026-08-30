import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJobs, upsertJob, mirrorJobs, STORAGE_NAME, type RidgesJob } from "../src/store.js";

let dir: string;
let extensionDataDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-ridges-store-"));
  extensionDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-ridges-extdata-"));
  process.env.FEZ_EXTENSION_DATA_DIR = extensionDataDir;
});

function job(over: Partial<RidgesJob> = {}): RidgesJob {
  return {
    id: "job-1",
    ts: "2026-08-30T00:00:00.000Z",
    persona: "scout",
    issueUrl: "https://github.com/foo/bar/issues/12",
    repo: "foo/bar",
    issueNumber: 12,
    status: "working",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...over,
  };
}

describe("STORAGE_NAME", () => {
  it("is fez-ridges — the installed package name", () => {
    expect(STORAGE_NAME).toBe("fez-ridges");
  });
});

describe("readJobs / upsertJob", () => {
  it("reads a missing store as empty", () => {
    expect(readJobs(dir)).toEqual([]);
  });

  it("reads a corrupt store as empty", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ridges-jobs.json"), "not json");
    expect(readJobs(dir)).toEqual([]);
  });

  it("round-trips a written job", () => {
    upsertJob(dir, job());
    expect(readJobs(dir)).toEqual([job()]);
  });

  it("appends a job with a new id", () => {
    upsertJob(dir, job({ id: "job-1" }));
    upsertJob(dir, job({ id: "job-2" }));
    expect(readJobs(dir).map((j) => j.id)).toEqual(["job-1", "job-2"]);
  });

  it("replaces a job with an existing id in place", () => {
    upsertJob(dir, job({ id: "job-1", status: "working" }));
    upsertJob(dir, job({ id: "job-2", status: "working" }));
    upsertJob(dir, job({ id: "job-1", status: "merged" }));
    const jobs = readJobs(dir);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual(job({ id: "job-1", status: "merged" }));
    expect(jobs[1].id).toBe("job-2");
  });

  it("persists the file at ridges-jobs.json under dir", () => {
    upsertJob(dir, job());
    expect(fs.existsSync(path.join(dir, "ridges-jobs.json"))).toBe(true);
  });

  // M2: the source file must not grow forever.
  it("caps the source file itself at the newest 1000", () => {
    for (let i = 0; i < 1002; i++) {
      upsertJob(dir, job({ id: `job-${i}` }));
    }
    const jobs = readJobs(dir);
    expect(jobs).toHaveLength(1000);
    expect(jobs[0].id).toBe("job-2");
    expect(jobs[999].id).toBe("job-1001");
  });
});

describe("mirrorJobs", () => {
  function readMirror() {
    return JSON.parse(fs.readFileSync(path.join(extensionDataDir, `${STORAGE_NAME}.json`), "utf8"));
  }

  it("mirrors the current store contents to fez-ridges.json in the extension-data dir", async () => {
    upsertJob(dir, job({ id: "job-1" }));
    upsertJob(dir, job({ id: "job-2" }));
    await mirrorJobs(dir);
    const mirrored = readMirror();
    expect(mirrored.jobs.map((j: RidgesJob) => j.id)).toEqual(["job-1", "job-2"]);
  });

  it("caps the mirrored jobs at the newest 500", async () => {
    for (let i = 0; i < 502; i++) {
      upsertJob(dir, job({ id: `job-${i}` }));
    }
    await mirrorJobs(dir);
    const mirrored = readMirror();
    expect(mirrored.jobs).toHaveLength(500);
    expect(mirrored.jobs[0].id).toBe("job-2");
    expect(mirrored.jobs[499].id).toBe("job-501");
  });

  it("never throws on an unwritable extension-data dir", async () => {
    process.env.FEZ_EXTENSION_DATA_DIR = "/dev/null/nope";
    upsertJob(dir, job());
    await expect(mirrorJobs(dir)).resolves.toBeUndefined();
  });
});
