import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The local job store — `ridges-jobs.json` under a caller-supplied `dir`
 * (the headless part's data dir; tests use a temp dir). Synchronous plain
 * fs, no queue: one process owns this file at a time via the extension
 * host, unlike the extension-data mirror below which several readers may
 * poll concurrently.
 *
 * Mirrored (read-only, best-effort) into the extension-storage namespace
 * at `<FEZ_EXTENSION_DATA_DIR|~/.fez/extension-data>/fez-ridges.json` —
 * same pattern as fez-wallet's storage-mirror.ts — so the gui part, which
 * is webview-sandboxed, can render jobs without reading the store file
 * directly.
 */

// Must match this package's INSTALLED name — see fez-wallet's
// storage-mirror.ts for the rename-bug precedent this constant exists to
// avoid repeating.
export const STORAGE_NAME = "fez-ridges";

const JOBS_FILE = "ridges-jobs.json";
const MAX_MIRROR = 500;

export interface RidgesJob {
  id: string;
  ts: string;
  persona: string;
  issueUrl: string;
  repo: string;
  issueNumber: number;
  title?: string;
  usd?: number;
  txHash?: string;
  status: "working" | "pr-open" | "merged" | "closed" | "payment-unclear" | "refused";
  prUrl?: string;
  prNumber?: number;
  updatedAt: string;
}

function jobsFile(dir: string): string {
  return path.join(dir, JOBS_FILE);
}

export function readJobs(dir: string): RidgesJob[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(jobsFile(dir), "utf8"));
    return Array.isArray(parsed) ? (parsed as RidgesJob[]) : [];
  } catch {
    return [];
  }
}

export function upsertJob(dir: string, job: RidgesJob): void {
  const jobs = readJobs(dir);
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = job;
  else jobs.push(job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jobsFile(dir), JSON.stringify(jobs, null, 2));
}

function extensionDataDir(): string {
  return process.env.FEZ_EXTENSION_DATA_DIR ?? path.join(os.homedir(), ".fez", "extension-data");
}

function mirrorFile(): string {
  return path.join(extensionDataDir(), `${STORAGE_NAME}.json`);
}

type MirrorState = { jobs?: RidgesJob[]; network?: string; [k: string]: unknown };

let chain: Promise<unknown> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
  const next = chain.then(op, op).catch(() => {});
  chain = next;
  return next as Promise<void>;
}

async function update(mutate: (s: MirrorState) => void): Promise<void> {
  return enqueue(async () => {
    const f = mirrorFile();
    let state: MirrorState = {};
    try {
      state = JSON.parse(await fsp.readFile(f, "utf8"));
    } catch { /* missing/corrupt reads as empty */ }
    mutate(state);
    try {
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, JSON.stringify(state, null, 2));
    } catch { /* best-effort — a failed mirror must never break the caller */ }
  });
}

/** Mirrors the CURRENT store contents (from `dir`), capped at the newest
 * 500, into the extension-data file. Existing `network` is left as-is. */
export function mirrorJobs(dir: string): Promise<void> {
  return update((s) => {
    s.jobs = readJobs(dir).slice(-MAX_MIRROR);
  });
}

/** Mirrors the network alongside a fresh read of the current jobs, so
 * whichever of mirrorJobs/mirrorNetwork runs last still leaves the file
 * fully consistent rather than one field going stale. */
export function mirrorNetwork(dir: string, network: string): Promise<void> {
  return update((s) => {
    s.jobs = readJobs(dir).slice(-MAX_MIRROR);
    s.network = network;
  });
}
