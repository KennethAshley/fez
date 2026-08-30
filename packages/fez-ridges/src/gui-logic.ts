import type { RidgesJob } from "./store.js";

/**
 * Pure display helpers for the bounty-rail pane (gui.tsx's `view.tsx`) —
 * no React, no DOM, no fs. Kept apart so the facts math and the mock's
 * exact status vocabulary are unit-testable without mounting anything.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface PaneFacts {
  live: number;
  merged: number;
  /** Sum of `usd` across rows PAID within the last 7 days (inclusive of
   * "this instant", exclusive of exactly 7 days ago — a row ages out the
   * moment it turns 7 days old). */
  weekUsd: number;
}

const LIVE_STATUSES = new Set<RidgesJob["status"]>(["working", "pr-open"]);

export function paneFacts(jobs: readonly RidgesJob[], now: Date): PaneFacts {
  let live = 0;
  let merged = 0;
  let weekUsd = 0;
  for (const j of jobs) {
    if (LIVE_STATUSES.has(j.status)) live++;
    if (j.status === "merged") merged++;
    if (typeof j.usd === "number" && now.getTime() - new Date(j.ts).getTime() < WEEK_MS) {
      weekUsd += j.usd;
    }
  }
  // Round off float accumulation (0.75 * N) to cents.
  return { live, merged, weekUsd: Math.round(weekUsd * 100) / 100 };
}

/** "4m ago" / "1h ago" / "2 days ago" — the mock's exact relative-time shape. */
export function relTime(ts: string, now: Date): string {
  const diffMs = Math.max(0, now.getTime() - new Date(ts).getTime());
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export interface StatusParts {
  /** The colored accent (mock's `.st-merged b` / `.st-closed b`) — only
   * merged/closed have one. Undefined everywhere else. */
  mark?: string;
  /** Everything else on the status line, dim. Full text when there's no mark. */
  rest: string;
}

/** The mock's exact status-line text, split into the colored mark (✓/✕)
 * and the dim remainder, so the view can render the mock's two-tone
 * merged/closed lines instead of one flat-colored string. Merged/closed
 * carry the row's relative time; the rest don't (the mock puts theirs in
 * the `.meta` row instead). Refused carries no message — a dim label. */
export function statusParts(job: RidgesJob, now: Date): StatusParts {
  switch (job.status) {
    case "working":
      return { rest: "working — the subnet has your issue" };
    case "pr-open":
      return { rest: "PR open — ready for your review" };
    case "merged":
      return { mark: "✓ merged", rest: ` — ${relTime(job.updatedAt, now)}` };
    case "closed":
      return { mark: "✕ closed unmerged", rest: ` — ${relTime(job.updatedAt, now)}` };
    case "payment-unclear":
      return { rest: "⚠ payment unclear — may have settled; check the receipt before retrying" };
    case "refused":
      return { rest: "refused" };
  }
}

/** The mock's exact status-line text, verbatim per status, as a single
 * string — `statusParts` above split apart for the view's two-tone
 * rendering; this is that same text concatenated back together. */
export function statusText(job: RidgesJob, now: Date): string {
  const { mark, rest } = statusParts(job, now);
  return mark ? `${mark}${rest}` : rest;
}

/** "repo#N", or the hostname-trimmed issue URL for a refused row where
 * repo/issueNumber were never established (store.ts records "" / 0). */
export function issueLabel(job: RidgesJob): string {
  if (job.repo && job.issueNumber) return `${job.repo}#${job.issueNumber}`;
  try {
    return new URL(job.issueUrl).pathname.replace(/^\//, "");
  } catch {
    return job.issueUrl;
  }
}
