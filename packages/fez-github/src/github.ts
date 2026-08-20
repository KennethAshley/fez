import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * GitHub, read side — over the `gh` CLI.
 *
 * gh already holds the credential (macOS keyring), refreshes it, and
 * knows the API's pagination, rate limits and error shapes. Reaching
 * past it to fetch() means reimplementing all three and inventing a
 * second place for a token to live. It is a hard dependency and the
 * extension says so plainly when it is missing, rather than failing in
 * some way you have to debug.
 *
 *   https://github.com/cli/cli#installation
 *
 * Everything here is read-only. Nothing in this module writes to GitHub.
 */

export interface Item {
  kind: "pr" | "issue";
  number: number;
  title: string;
  author: string;
  state: string;
  /** PRs only: merged closes differently from closed. */
  merged?: boolean;
  url: string;
  updatedAt: string;
  comments: number;
}

/** `owner/name`, and nothing else — this string is interpolated into an API path. */
const REPO = /^[\w.-]+\/[\w.-]+$/;
export const validRepo = (repo: string): boolean => REPO.test(repo);

export type Readiness = { ok: true } | { ok: false; why: string };

/** Is gh installed and logged in? The two failures need different fixes, so they read differently. */
export async function ready(): Promise<Readiness> {
  try {
    await run("gh", ["--version"], { timeout: 10_000 });
  } catch {
    return { ok: false, why: "the gh CLI isn't installed — https://github.com/cli/cli#installation" };
  }
  try {
    await run("gh", ["auth", "status"], { timeout: 15_000 });
    return { ok: true };
  } catch {
    return { ok: false, why: "gh is installed but not logged in — run: gh auth login" };
  }
}

async function api<T>(path: string): Promise<T> {
  // execFile, never exec: no shell, so a repo name can never become a
  // command. validRepo is belt to this one's braces.
  const { stdout } = await run("gh", ["api", path], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  updated_at: string;
  comments: number;
  user?: { login?: string };
  pull_request?: { merged_at?: string | null };
}

/**
 * Recently-touched items, newest activity first.
 *
 * Deliberately NOT paginated. Sorting by `updated_at` desc means the
 * first page is everything that has changed since the last poll —
 * anything below it is by definition older than something we have
 * already recorded. Paginating here would walk the repo's entire
 * history every few minutes to learn nothing.
 *
 * The issues endpoint returns PRs too (GitHub models a PR as an issue),
 * so `pull_request` is what separates them. One endpoint rather than two
 * keeps a single ordering, which is what that watermark argument needs.
 */
export async function recentItems(repo: string, limit = 50): Promise<Item[]> {
  if (!validRepo(repo)) throw new Error(`not a repo name: "${repo}"`);
  const raw = await api<RawIssue[]>(
    `repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=${Math.min(limit, 100)}`
  );
  return raw.map((row) => ({
    kind: row.pull_request ? "pr" : "issue",
    number: row.number,
    title: row.title,
    author: row.user?.login ?? "someone",
    state: row.state,
    merged: row.pull_request ? !!row.pull_request.merged_at : undefined,
    url: row.html_url,
    updatedAt: row.updated_at,
    comments: row.comments,
  }));
}

/** The check rollup for a PR's head commit, or undefined when there is none. */
export async function checksFor(repo: string, number: number): Promise<string | undefined> {
  if (!validRepo(repo)) return undefined;
  try {
    const pr = await api<{ head?: { sha?: string } }>(`repos/${repo}/pulls/${number}`);
    if (!pr.head?.sha) return undefined;
    const runs = await api<{ check_runs?: { conclusion?: string | null; status?: string }[] }>(
      `repos/${repo}/commits/${pr.head.sha}/check-runs`
    );
    const all = runs.check_runs ?? [];
    if (all.length === 0) return undefined;
    const failed = all.filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out").length;
    const pending = all.filter((c) => c.status !== "completed").length;
    if (failed > 0) return `${failed}/${all.length} checks failing`;
    if (pending > 0) return `${pending}/${all.length} checks running`;
    return `${all.length} checks passing`;
  } catch {
    return undefined; // checks are decoration; never fail a poll over them
  }
}

/**
 * One line describing an item.
 *
 * The TITLE and a LINK, never the body. A body is long and this is a
 * notification rather than a mirror — but the real reason is that on a
 * public repo anyone can open a PR whose body says whatever they like,
 * and putting that prose in a channel puts attacker-authored text in
 * front of every agent reading the room. A title is small enough to
 * take in at a glance and a link is inert. An agent that needs the body
 * fetches it through the github skill, where it arrives as tool output
 * the harness already treats as untrusted.
 */
export function headline(item: Item): string {
  const mark =
    item.kind === "pr" ? (item.merged ? "merged" : item.state === "closed" ? "closed" : "open") : item.state;
  const icon = item.kind === "pr" ? "⑂" : "◇";
  return `${icon} **#${item.number}** ${item.title.replace(/\s+/g, " ").trim()}\n${item.author} · ${mark} · ${item.url}`;
}

/** `owner/name` → the channel name. Short, lowercase, no slash. */
export function channelNameFor(repo: string): string {
  return (repo.split("/")[1] ?? repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 32);
}
