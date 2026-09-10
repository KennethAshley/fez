import { matchPr } from "./github.js";
import { readJobs, upsertJob, type RidgesJob } from "./store.js";
import type { FetchLike } from "./dispatch.js";

/**
 * Watches GitHub for the PR a paid dispatch bought, and transitions job
 * rows honestly as that PR moves (open → merged/closed). No money logic
 * here — this only reads public PR listings and matches/transitions rows
 * `dispatch.ts` already wrote.
 */

/** In-memory, per-repo state the caller holds between ticks — never
 * persisted (a sentinel restart just re-fetches with no etag/backoff). */
export interface PollerState {
  etags: Map<string, string>;
  backoffUntil: Map<string, number>; // epoch seconds, from x-ratelimit-reset
  deadRepos: Set<string>;
}

export function createPollerState(): PollerState {
  return { etags: new Map(), backoffUntil: new Map(), deadRepos: new Set() };
}

interface GhPr {
  number: number;
  title?: string | null;
  body?: string | null;
  state: "open" | "closed";
  merged_at?: string | null;
  html_url: string;
  head?: { ref?: string };
}

const OPEN_STATUSES = new Set<RidgesJob["status"]>(["working", "pr-open"]);

/**
 * One poll tick. Fetches each DISTINCT repo among open (`working`/
 * `pr-open`) jobs at most once, matches any still-unmatched job to a PR
 * (first match, permanent), and transitions matched jobs by that PR's
 * current state. Zero fetches when there is nothing open to poll.
 */
export async function pollOnce(deps: {
  dir: string;
  fetchImpl: FetchLike;
  now?: () => string;
  state?: PollerState;
}): Promise<void> {
  const now = () => (deps.now ? deps.now() : new Date().toISOString());
  // Reuses the same controllable clock as `now()` rather than a second
  // time source — epoch seconds, comparable to GitHub's rate-limit reset.
  const nowSec = () => Math.floor(Date.parse(now()) / 1000);
  const waiting = (job: RidgesJob) => job.status === "working" && job.prNumber == null && Date.parse(now()) - Date.parse(job.ts) >= 3600000
    ? "No matching PR after one hour. Check the issue or contact Ridges support; do not redispatch a paid job." : undefined;
  const state = deps.state ?? createPollerState();

  const openJobs = readJobs(deps.dir).filter((j) => OPEN_STATUSES.has(j.status) && j.repo);
  if (openJobs.length === 0) return;

  const repos = [...new Set(openJobs.map((j) => j.repo))];

  for (const repo of repos) {
    const note = (message: string | undefined | ((job: RidgesJob) => string | undefined)) => {
      for (const job of openJobs.filter(j => j.repo === repo)) {
        const text = typeof message === "function" ? message(job) : message;
        if (job.pollingNote === text) continue;
        upsertJob(deps.dir, { ...job, pollingNote: text, pendingUpdate: true, updatedAt: now() });
      }
    };
    if (state.deadRepos.has(repo)) continue;
    const until = state.backoffUntil.get(repo);
    if (until != null && nowSec() < until) continue;

    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    const etag = state.etags.get(repo);
    if (etag) headers["If-None-Match"] = etag;

    let res;
    try {
      res = await deps.fetchImpl(
        `https://api.github.com/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=30`,
        { headers }
      );
    } catch {
      note("GitHub unavailable; tracking will retry.");
      continue; // transient — skip silently this tick
    }

    if (res.status === 304) { note(waiting); continue; }

    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(reset)) state.backoffUntil.set(repo, reset);
      note("GitHub rate limit reached; tracking is delayed.");
      continue;
    }

    if (res.status === 404) {
      console.warn(`ridges: repo ${repo} unreadable — private? token support later`);
      state.deadRepos.add(repo); // dead for this state's lifetime
      note("Repository unreadable (HTTP 404); tracking stopped until the sentinel restarts. Check repository access; do not redispatch.");
      continue;
    }

    if (res.status !== 200) { note(`GitHub HTTP ${res.status}; tracking will retry.`); continue; }

    const newEtag = res.headers.get("etag");
    if (newEtag) state.etags.set(repo, newEtag);

    let prs: GhPr[];
    try {
      const body = JSON.parse(await res.text());
      if (!Array.isArray(body)) { note("Invalid GitHub response; tracking will retry."); continue; }
      prs = body;
    } catch {
      note("Invalid GitHub response; tracking will retry.");
      continue;
    }

    for (const job of openJobs.filter((j) => j.repo === repo)) {
      let updated = job.pollingNote ? { ...job, pollingNote: undefined } : job;

      // First-match permanence: a job with a prNumber is never re-matched,
      // even if a newer PR in this same list also matches.
      if (updated.prNumber == null) {
        const match = prs.find((pr) =>
          matchPr(updated.issueNumber, { title: pr.title ?? "", body: pr.body ?? "", headRef: pr.head?.ref ?? "" })
        );
        if (match) updated = { ...updated, prUrl: match.html_url, prNumber: match.number };
      }

      if (updated.prNumber != null) {
        const pr = prs.find((p) => p.number === updated.prNumber);
        // Not in this 30-PR window (old PR) → leave the row unchanged.
        if (pr) {
          const status: RidgesJob["status"] | undefined = pr.merged_at
            ? "merged"
            : pr.state === "closed"
              ? "closed"
              : pr.state === "open"
                ? "pr-open"
                : undefined;
          if (status && status !== updated.status) updated = { ...updated, status };
        }
      }

      updated = { ...updated, pollingNote: waiting(updated) };

      if (updated.status !== job.status || updated.prNumber !== job.prNumber || updated.prUrl !== job.prUrl || updated.pollingNote !== job.pollingNote) {
        upsertJob(deps.dir, { ...updated, updatedAt: now(), pendingUpdate: true });
      }
    }
  }

}
