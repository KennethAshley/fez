import { randomUUID } from "node:crypto";
import { parseIssueUrl } from "./github.js";
import { upsertJob, type RidgesJob } from "./store.js";
import { formatJob } from "./status.js";

/**
 * Structurally just enough of the Fetch API for the title lookup — same
 * shape the wallet's own FetchLike uses, so a real `fetch` or a test
 * double satisfies both without adaptation.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/**
 * The slice of the wallet's `X402Outcome` this module reads. Kept local
 * (rather than importing the wallet's type) so this file only cares
 * about the fields it actually uses — the wallet's outcome carries a few
 * more (contentType, payTo, receiptNote, …) that never matter here.
 */
export type X402Outcome =
  | { kind: "response"; status: number; bodyText: string }
  | { kind: "paid"; status: number; bodyText: string; txHash: string; usd: number }
  | { kind: "refused"; message: string }
  | { kind: "ambiguous"; message: string; usd: number; txHash?: string };

/**
 * `x402FetchRaw`-shaped, but deliberately typed with an opaque deps
 * param: this module must never know what a wallet's X402ToolDeps looks
 * like (no keys, no cap logic, no consent logic here — the global
 * constraint). The real wiring in headless.ts/mcp.ts adapts the actual
 * `x402FetchRaw` to this shape with a one-line cast.
 */
export type X402Call = (
  x402Deps: unknown,
  args: { url: string; method?: string; body?: string; maxUsd: number }
) => Promise<X402Outcome>;

export interface DispatchDeps {
  persona: string;
  /** The ridges job-store dir (store.ts's `dir` — see readJobs/upsertJob). */
  dir: string;
  x402: X402Call;
  /** Opaque — passed straight through to `x402`. */
  x402Deps: unknown;
  fetchImpl?: FetchLike;
  now?: () => string;
}

const RIDGES_ISSUES_URL = "https://product.ridges.ai/v1/issues";
const DEFAULT_MAX_USD = 5;

/**
 * Pays the Ridges subnet, through the wallet, to work an issue.
 *
 * No money logic lives here: every spend decision (caps, consent,
 * offers) already happened inside `deps.x402` before this ever sees an
 * outcome. This function's only job is turning that outcome into an
 * honest job row and an honest reply — refusing before payment is
 * checked BEFORE the network is touched at all (zero x402 calls for an
 * invalid URL).
 */
export async function dispatchRidges(deps: DispatchDeps, args: { issueUrl: string; maxUsd?: number }): Promise<string> {
  const now = () => (deps.now ? deps.now() : new Date().toISOString());
  const record = async (job: RidgesJob) => {
    upsertJob(deps.dir, job);
  };

  const parsed = parseIssueUrl(args.issueUrl);
  if (!parsed) {
    const ts = now();
    const message = "ridges: not a github issue URL — expected https://github.com/<owner>/<repo>/issues/<number>";
    await record({
      id: randomUUID(),
      ts,
      persona: deps.persona,
      issueUrl: args.issueUrl,
      // Owner/repo/issue-number were never established — there is
      // nothing else honest to put here.
      repo: "",
      issueNumber: 0,
      usd: undefined,
      status: "refused",
      detail: message,
      updatedAt: ts,
    });
    return message;
  }

  const repo = `${parsed.owner}/${parsed.repo}`;
  const title = await fetchTitle(deps.fetchImpl, parsed.owner, parsed.repo, parsed.issueNumber);

  const outcome = await deps.x402(deps.x402Deps, {
    url: RIDGES_ISSUES_URL,
    method: "POST",
    body: JSON.stringify({ github_issue_url: args.issueUrl }),
    maxUsd: args.maxUsd ?? DEFAULT_MAX_USD,
  });

  const ts = now();
  const base = {
    ts,
    persona: deps.persona,
    issueUrl: args.issueUrl,
    repo,
    issueNumber: parsed.issueNumber,
    title,
    updatedAt: ts,
  };

  switch (outcome.kind) {
    case "response": {
      // The 404 app-not-installed guard (and any other non-402 refusal)
      // carries its explanation in `detail` — surfaced because it's the
      // one that names the install link. I4: Ridges is a third party;
      // an unbounded, multi-line `detail` (or, absent one, the raw
      // bodyText — the T3 non-JSON/missing-detail fallback) could forge
      // fake lines into a reply a wallet message decorator renders as a
      // card (e.g. a fake "receive address" line) — collapsed to one
      // line and capped, same as the wallet's own `oneLine` for exactly
      // this reason.
      const detail = readStringField(outcome.bodyText, "detail");
      const raw = detail ?? (outcome.bodyText || `HTTP ${outcome.status}`);
      const message = `ridges refused before payment — ${oneLine(raw).slice(0, 500)}`;
      await record({ ...base, id: randomUUID(), status: "refused", detail: message });
      return message;
    }
    case "refused": {
      await record({ ...base, id: randomUUID(), status: "refused", detail: oneLine(outcome.message).slice(0, 500) });
      return outcome.message;
    }
    case "paid": {
      // M1: `issue_id` is the PROVIDER's own id, not ours — recorded as
      // `providerId` for reference, but this row's `id` (what upsertJob
      // keys on) is always our own, so a fixed/repeated provider id can
      // never overwrite an unrelated paid row.
      const issueId = readStringField(outcome.bodyText, "issue_id");
      const job: RidgesJob = { ...base, id: randomUUID(), providerId: issueId, status: "working", usd: outcome.usd, txHash: outcome.txHash };
      await record(job);
      return `ridges: dispatched — the subnet has your issue (paid $${outcome.usd.toFixed(2)}, tx ${outcome.txHash})\n${formatJob(job)}\nCheck progress with ridges_status or /ridges status. Background tracking requires the Fez sentinel.`;
    }
    case "ambiguous": {
      await record({ ...base, id: randomUUID(), status: "payment-unclear", usd: outcome.usd, txHash: outcome.txHash, detail: oneLine(outcome.message).slice(0, 500) });
      const txNote = outcome.txHash ? ` (${outcome.txHash})` : "";
      return `${outcome.message} If it settled, do not re-dispatch — contact Ridges support with the tx hash${txNote}.`;
    }
  }
}

/** Collapses whitespace/control characters (including newlines) to a
 * single space and trims — mirrors the wallet's own `oneLine` (tools.ts):
 * a hostile third party's text must never carry a fake extra "line" into
 * a message a decorator might render as a card. */
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  return s.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
}

/** Reads one string (or number, stringified) field out of a JSON body —
 * never throws, a missing/malformed body just yields undefined. */
function readStringField(bodyText: string, field: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const v = parsed[field];
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort — a failed/slow/non-200 title lookup must never block or
 * fail the dispatch; the job just stays untitled. */
async function fetchTitle(fetchImpl: FetchLike | undefined, owner: string, repo: string, issueNumber: number): Promise<string | undefined> {
  const impl = fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const res = await impl(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`);
    if (res.status !== 200) return undefined;
    return readStringField(await res.text(), "title");
  } catch {
    return undefined;
  }
}
