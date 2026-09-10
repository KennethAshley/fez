import { readJobs, type RidgesJob } from "./store.js";

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
const states: Record<RidgesJob["status"], string> = {
  working: "working — waiting for a PR", "pr-open": "PR open — ready for review",
  merged: "merged", closed: "closed unmerged", refused: "refused — nothing paid",
  "payment-unclear": "payment unclear — may have settled; do not retry; contact Ridges support",
};

export function formatJob(job: RidgesJob): string {
  return [
    `${clean(job.persona)} · ${states[job.status]}`,
    `Issue: ${clean(job.issueUrl)}${job.title ? ` — ${clean(job.title)}` : ""}`,
    job.prUrl ? `PR: ${clean(job.prUrl)}` : "PR: not reported",
    typeof job.usd === "number" ? `${job.status === "payment-unclear" ? "Possible payment" : "Paid"}: $${job.usd.toFixed(2)} · Base mainnet` : undefined,
    `Receipt: ${job.txHash ? clean(job.txHash) : "not reported"} · job ${clean(job.id)}`,
    job.providerId ? `Ridges ID: ${clean(job.providerId)}` : undefined,
    `Created: ${clean(job.ts)} · updated: ${clean(job.updatedAt)}`,
    job.detail ? clean(job.detail) : undefined,
    job.pollingNote ? `Tracking: ${clean(job.pollingNote)}` : undefined,
  ].filter(Boolean).join("\n");
}

/** The same paginated ledger for the slash command and persona-scoped MCP tool. */
export function statusReport(dir: string, opts: { persona?: string; offset?: number; limit?: number; now?: number } = {}): string {
  const jobs = readJobs(dir).filter(j => !opts.persona || j.persona === opts.persona).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const offset = opts.offset ?? 0, limit = opts.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw Error("Invalid history page");
  const week = jobs.filter(j => (opts.now ?? Date.now()) - Date.parse(j.ts) >= 0 && (opts.now ?? Date.now()) - Date.parse(j.ts) < 7 * 86400000);
  const sum = (unclear: boolean) => week.filter(j => (j.status === "payment-unclear") === unclear && j.status !== "refused").reduce((n, j) => n + (j.usd ?? 0), 0).toFixed(2);
  const summary = `Ridges · ${jobs.filter(j => j.status === "working" || j.status === "pr-open").length} live · ${jobs.filter(j => j.status === "merged").length} merged · $${sum(false)} paid this week · $${sum(true)} payment unclear this week · Base mainnet`;
  const page = jobs.slice(offset, offset + limit);
  return [summary, page.length ? `Jobs ${offset + 1}–${offset + page.length} of ${jobs.length}` : "No jobs on this page.", ...page.map(formatJob),
    offset + limit < jobs.length ? `More history: offset ${offset + limit} (/ridges status ${offset + limit}).` : "",
    "Background tracking requires the Fez sentinel. Desktop agents use ridges_updates to inspect/configure announcements. Headless command: /ridges watch <channel-id|off>.",
  ].filter(Boolean).join("\n\n");
}
