import { matchPr } from "./github.js";
import { mirrorJobs, readJobs, upsertJob, type RidgesJob } from "./store.js";
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
  const state = deps.state ?? createPollerState();

  const openJobs = readJobs(deps.dir).filter((j) => OPEN_STATUSES.has(j.status) && j.repo);
  if (openJobs.length === 0) return;

  const repos = [...new Set(openJobs.map((j) => j.repo))];
  let anyChanged = false;

  for (const repo of repos) {
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
      continue; // transient — skip silently this tick
    }

    if (res.status === 304) continue; // nothing new; jobs untouched this tick

    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(reset)) state.backoffUntil.set(repo, reset);
      continue;
    }

    if (res.status === 404) {
      console.warn(`ridges: repo ${repo} unreadable — private? token support later`);
      state.deadRepos.add(repo); // dead for this state's lifetime
      continue;
    }

    if (res.status !== 200) continue; // transient — skip silently this tick

    const newEtag = res.headers.get("etag");
    if (newEtag) state.etags.set(repo, newEtag);

    let prs: GhPr[];
    try {
      const body = JSON.parse(await res.text());
      if (!Array.isArray(body)) continue;
      prs = body;
    } catch {
      continue;
    }

    for (const job of openJobs.filter((j) => j.repo === repo)) {
      let updated = job;

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

      if (updated !== job) {
        upsertJob(deps.dir, { ...updated, updatedAt: now() });
        anyChanged = true;
      }
    }
  }

  if (anyChanged) await mirrorJobs(deps.dir);
}
