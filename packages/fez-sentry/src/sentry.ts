import type { Config } from "./config.js";

export interface Issue {
  id: string;
  title: string;
  count: string;
  status: "unresolved" | "resolved" | "ignored";
  firstSeen: string;
  lastSeen: string;
}
const numericId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,29}$/.test(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Sentry response");
  return value as Record<string, unknown>;
};
const timestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

export class SentryRateLimit extends Error {
  constructor(readonly retryAt: number) { super("Sentry rate limit reached; waiting before the next poll"); }
}

async function request(url: URL, token: string, fetcher: typeof fetch, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try { response = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal }); }
  catch { throw Error("Sentry request failed or timed out; check the region, connection and token"); }
  if (response.status === 429) {
    const after = response.headers.get("retry-after") ?? "60";
    const delay = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
    throw new SentryRateLimit(Date.now() + Math.min(900_000, Math.max(60_000, Number.isFinite(delay) ? delay : 60_000)));
  }
  if (!response.ok) throw Error(`Sentry API returned HTTP ${response.status}; check the project and read token`);
  // Isolated GUI transport follows redirects natively; never trust a response from another origin.
  if (response.url && new URL(response.url).origin !== url.origin) throw Error("Sentry API redirected outside the selected region");
  return response;
}
async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw Error("Sentry returned invalid JSON"); }
}

export async function resolveProject(config: Config, token: string, fetcher: typeof fetch = fetch, signal = AbortSignal.timeout(10_000)): Promise<string> {
  const url = new URL(`/api/0/projects/${config.organization}/${config.project}/`, config.origin);
  const project = record(await json(await request(url, token, fetcher, signal)));
  if (!numericId(project.id) || project.slug !== config.project || record(project.organization).slug !== config.organization) throw Error("Sentry returned a different or invalid project");
  return project.id;
}

function parseIssue(raw: unknown, projectId: string, projectSlug: string): Issue {
  const row = record(raw), project = record(row.project);
  if (project.id !== projectId || project.slug !== projectSlug) throw Error("Sentry returned an issue from another project");
  if (!numericId(row.id)) throw Error("Sentry returned an invalid issue ID");
  if (typeof row.title !== "string" || !row.title.trim() || row.title.length > 100_000) throw Error("Sentry returned an invalid issue title");
  if (typeof row.count !== "string" || !/^(0|[1-9][0-9]{0,29})$/.test(row.count)) throw Error("Sentry returned an invalid issue count");
  if (row.status !== "unresolved" && row.status !== "resolved" && row.status !== "ignored") throw Error("Sentry returned an invalid issue status");
  if (!timestamp(row.firstSeen) || !timestamp(row.lastSeen) || Date.parse(row.firstSeen) > Date.parse(row.lastSeen)) throw Error("Sentry returned invalid issue times");
  return { id: row.id, title: row.title.slice(0, 200), count: row.count, status: row.status, firstSeen: row.firstSeen, lastSeen: row.lastSeen };
}

/** A complete bounded scan: a partial page sequence never becomes a successful baseline. */
export async function fetchIssues(config: Config, token: string, fetcher: typeof fetch = fetch): Promise<Issue[]> {
  const signal = AbortSignal.timeout(45_000);
  const project = await resolveProject(config, token, fetcher, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
  const url = new URL(`/api/0/organizations/${config.organization}/issues/`, config.origin);
  url.search = new URLSearchParams({ project, query: "", statsPeriod: "90d", sort: "new", limit: "100" }).toString();
  const issues = new Map<string, Issue>(), cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const response = await request(url, token, fetcher, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    const rows = await json(response);
    if (!Array.isArray(rows) || rows.length > 100) throw Error("Sentry returned an invalid issue page");
    for (const row of rows) { const issue = parseIssue(row, project, config.project); issues.set(issue.id, issue); }
    const links = response.headers.get("link")?.split(/,\s*(?=<)/) ?? [];
    const next = links.find(link => /;\s*rel="next"/.test(link));
    if (!next) {
      if (rows.length === 100) throw Error("Sentry omitted pagination for a full page; no progress saved");
      return [...issues.values()];
    }
    if (/;\s*results="false"/.test(next)) return [...issues.values()];
    if (!/;\s*results="true"/.test(next)) throw Error("Sentry returned invalid pagination");
    const target = /^<([^>]+)>/.exec(next)?.[1];
    if (!target) throw Error("Sentry returned invalid pagination");
    let nextUrl: URL;
    try { nextUrl = new URL(target); } catch { throw Error("Sentry returned invalid pagination"); }
    const cursor = nextUrl.searchParams.get("cursor");
    if (nextUrl.origin !== url.origin || nextUrl.pathname !== url.pathname || !cursor || cursor.length > 200 || !/^[0-9:-]+$/.test(cursor) || cursors.has(cursor)) throw Error("Sentry returned unsafe or repeated pagination");
    cursors.add(cursor); url.searchParams.set("cursor", cursor);
  }
  throw Error("Sentry scan exceeded 2,000 issues / 20 pages; no progress saved");
}

export const issueUrl = (config: Config, issue: Issue): string => `${config.origin}/organizations/${config.organization}/issues/${issue.id}/`;
