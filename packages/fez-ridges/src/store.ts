import fs from "node:fs";
import path from "node:path";

/** Local paid-job history. Shared by command replies, MCP status and background tracking. */
const JOBS_FILE = "ridges-jobs.json";
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
  detail?: string;
  pollingNote?: string;
  /** Persisted until an opted-in channel announcement succeeds. */
  pendingUpdate?: boolean;
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
 * at the newest 1000; history is retained independently of the optional announcement channel. */
export function upsertJob(dir: string, job: RidgesJob): void {
  const jobs = readJobs(dir);
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = job;
  else jobs.push(job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jobsFile(dir), JSON.stringify(jobs.slice(-MAX_STORE), null, 2));
}

export function updatesChannel(dir: string): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, "ridges-updates.json"), "utf8"));
    if (value.channel === null) return undefined;
    if (typeof value.channel !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.channel)) throw Error();
    return value.channel;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return undefined;
    // eslint-disable-next-line preserve-caught-error -- Raw errors may expose private response or process data.
    throw Error("Ridges update-channel settings are unreadable; announcements stopped");
  }
}

export function setUpdatesChannel(dir: string, channel: string | null): void {
  if (channel !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(channel)) throw Error("Invalid updates channel ID");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ridges-updates.json"), JSON.stringify({ channel }), { mode: 0o600 });
}
