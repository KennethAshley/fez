/**
 * Pure GitHub URL/PR-reference logic — no network. STRICT parsing so a bad
 * issue URL is rejected before any x402 spend is even considered.
 */

const ISSUE_PATH_RE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([0-9]+)$/;

export function parseIssueUrl(url: string): { owner: string; repo: string; issueNumber: number } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com") return undefined;
  const m = ISSUE_PATH_RE.exec(u.pathname);
  if (!m) return undefined;
  const issueNumber = Number(m[3]);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return undefined;
  return { owner: m[1], repo: m[2], issueNumber };
}

const KEYWORDS = ["fixes", "fix", "closes", "close", "resolves", "resolve"];

/**
 * True when a PR looks like it closes the given issue: a closing keyword
 * (fixes/closes/resolves) followed by #N, a bare (#N), or a head branch
 * naming the issue (issue-N / N-...). Every check is word-boundary safe on
 * the number so #12 never fires for issue 1, 123, etc.
 */
export function matchPr(issueNumber: number, pr: { title: string; body: string; headRef: string }): boolean {
  const n = String(issueNumber);
  const text = `${pr.title}\n${pr.body}`;
  const keywordRe = new RegExp(`\\b(?:${KEYWORDS.join("|")})\\b[:\\s]*#${n}\\b`, "i");
  const parenRe = new RegExp(`\\(#${n}\\)`);
  if (keywordRe.test(text) || parenRe.test(text)) return true;

  const branchIssueRe = new RegExp(`(?:^|[^0-9])issue-${n}(?:[^0-9]|$)`, "i");
  const branchPrefixRe = new RegExp(`^${n}-`);
  return branchIssueRe.test(pr.headRef) || branchPrefixRe.test(pr.headRef);
}
