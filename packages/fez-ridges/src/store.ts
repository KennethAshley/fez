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
const MAX_STORE = 1000;

export interface RidgesJob {
  /** Our OWN identity for this row — never the provider's `issue_id`
   * (M1): a server-controlled id is either attacker-influenced or just a
   * dumb collision waiting to happen, and `upsertJob` keys on `id` — one
   * constant value from a buggy or hostile provider would silently
   * overwrite an unrelated paid row instead of recording a new one. */
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
  /** The provider's own issue id (Ridges' `issue_id`), kept for reference
   * only — never used as this row's identity. Absent when the provider
   * never returned one, or the job never reached that outcome. */
  providerId?: string;
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

/** M2: the source file grows one row per dispatch forever otherwise — an
 * unbounded local JSON file for a wallet that could run for years. Capped
 * at the newest 1000; the mirror's own 500-cap is unaffected (unrelated,
 * smaller, and already there for the same reason). */
export function upsertJob(dir: string, job: RidgesJob): void {
  const jobs = readJobs(dir);
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = job;
  else jobs.push(job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jobsFile(dir), JSON.stringify(jobs.slice(-MAX_STORE), null, 2));
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

