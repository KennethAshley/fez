import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { currentToken } from "./auth.js";

/**
 * GitHub, read side.
 *
 * Octokit rather than raw fetch, and rather than the `gh` CLI it started
 * as. gh was chosen because it already held a credential — once fez
 * holds its own (device flow, GitHub App), gh's remaining value was
 * pagination and rate limits, which a library gives without requiring an
 * install. Dropping it means the extension works on a machine with no
 * developer tooling at all, which is the whole point of the OAuth move.
 *
 * The two plugins are not decoration. The hand-rolled version I wrote
 * first had already shipped a real bug — per_page=30 with no pagination,
 * so a repo with 40 open pull requests silently lost 10 — and had no
 * answer at all for GitHub's secondary rate limits, which are separate
 * from the 5000/hour everyone knows about.
 *
 * Everything here is read-only, and not merely by convention: the app's
 * permissions are Issues/Pull requests/Checks READ, fixed at install.
 * There is no call in this file that GitHub would let us make anyway.
 */

const FezOctokit = Octokit.plugin(throttling, retry);

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

/** `owner/name`, and nothing else. */
const REPO = /^[\w.-]+\/[\w.-]+$/;
export const validRepo = (repo: string): boolean => REPO.test(repo);

export type Readiness = { ok: true; login: string } | { ok: false; why: string };

let client: InstanceType<typeof FezOctokit> | undefined;
let clientToken: string | undefined;

async function api(): Promise<InstanceType<typeof FezOctokit>> {
  const token = await currentToken();
  if (!token) throw new Error("not connected to GitHub — run: fez github connect --client-id <id>");
  // Rebuild when the token rotates: GitHub App user tokens last 8 hours,
  // so a long-lived sentinel WILL outlive the one it started with.
  if (!client || clientToken !== token) {
    clientToken = token;
    client = new FezOctokit({
      auth: token,
      userAgent: "fez-github",
      throttle: {
        // Retry a limited number of times, then give up and let the next
        // poll try. A bridge that waits out a long limit is a bridge
        // holding the sentinel's task slot for an hour.
        onRateLimit: (retryAfter: number, options: { method: string; url: string }, _o: unknown, retryCount: number) => {
          console.warn(`⚠️  fez-github: rate limited on ${options.method} ${options.url} — ${retryAfter}s`);
          return retryCount < 2;
        },
        onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }, _o: unknown, retryCount: number) => {
          console.warn(`⚠️  fez-github: secondary limit on ${options.method} ${options.url} — ${retryAfter}s`);
          return retryCount < 1;
        },
      },
    });
  }
  return client;
}

/** Is fez connected, and to whom? The two failures need different fixes. */
export async function ready(): Promise<Readiness> {
  let octokit: InstanceType<typeof FezOctokit>;
  try {
    octokit = await api();
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return { ok: true, login: data.login };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) return { ok: false, why: "GitHub rejected the token — reconnect: fez github connect" };
    return { ok: false, why: `GitHub unreachable (${status ?? "network"})` };
  }
}

export interface InstalledRepo {
  repo: string;
  private: boolean;
}

/**
 * The repos this App is installed on — i.e. everything fez can see.
 *
 * The picker used to be a text box you typed `owner/name` into, which
 * let you ask for a repo the App was not installed on and get silence:
 * the poll would 404 forever and the channel would never open. Asking
 * GitHub what it will actually serve makes the wrong choice
 * unrepresentable.
 *
 * Two hops because that is how GitHub models it — the user's
 * installations, then each installation's repositories — and paginated
 * for real here, unlike recentItems: this is a full list with no
 * recency ordering to lean on, so page two is not older news, it is
 * simply the rest of the answer.
 */
export async function installedRepos(): Promise<InstalledRepo[]> {
  const octokit = await api();
  const { data: installs } = await octokit.rest.apps.listInstallationsForAuthenticatedUser({ per_page: 100 });
  const out: InstalledRepo[] = [];
  for (const install of installs.installations) {
    const repos = await octokit.paginate(octokit.rest.apps.listInstallationReposForAuthenticatedUser, {
      installation_id: install.id,
      per_page: 100,
    });
    for (const repo of repos) out.push({ repo: repo.full_name, private: repo.private });
  }
  // Stable order, so the picker does not reshuffle between polls.
  return out.sort((a, b) => a.repo.localeCompare(b.repo));
}

/**
 * Recently-touched items, newest activity first.
 *
 * Deliberately NOT paginated, and that is a different claim from the bug
 * this replaces. Sorted by `updated_at` desc, the first page IS
 * everything that changed since the last poll — anything below it is
 * older than something already recorded. Walking further would re-read
 * the repo's history every few minutes to learn nothing.
 *
 * The issues endpoint returns pull requests too (GitHub models a PR as
 * an issue), so `pull_request` separates them. One endpoint keeps one
 * ordering, which is what the watermark argument above depends on.
 */
export async function recentItems(repo: string, limit = 50): Promise<Item[]> {
  if (!validRepo(repo)) throw new Error(`not a repo name: "${repo}"`);
  const [owner, name] = repo.split("/");
  const octokit = await api();
  const { data } = await octokit.rest.issues.listForRepo({
    owner,
    repo: name,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: Math.min(limit, 100),
  });
  return data.map((row) => ({
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
  const [owner, name] = repo.split("/");
  try {
    const octokit = await api();
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: number });
    if (!pr.head?.sha) return undefined;
    const { data: runs } = await octokit.rest.checks.listForRef({ owner, repo: name, ref: pr.head.sha });
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
 * public repo anyone can open a pull request whose body says whatever
 * they like, and putting that prose in a channel puts attacker-authored
 * text in front of every agent reading the room. A title is small enough
 * to take in at a glance and a link is inert.
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
