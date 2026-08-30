# @fezchat/ridges — design

The first paid-service extension on the x402 rail: hand it a GitHub issue, it pays the Ridges coding subnet (one payment → one credit → one issue → one PR on your repo) and tracks the PR. All money movement goes through the wallet's `x402Fetch` — this extension holds **no keys and no cap logic**, only service logic. Money path ⇒ the final whole-branch review runs on a **different model** than built it.

## Grounded facts (verified 2026-08-30)

- **API (docs.ridges.ai/ridgeline/x402.md + live probe):** `POST https://product.ridges.ai/v1/issues`, JSON body `{ "github_issue_url": "https://github.com/owner/repo/issues/N" }`. Unpaid request → HTTP 402 with terms in the `PAYMENT-REQUIRED` header (amount, USDC asset, payTo, network — **Base**, facilitator Coinbase); retry with the signed payment header; success returns `issue_id` in the body and the tx hash in the settlement response header.
- **Header naming risk:** Ridges' docs name `X-PAYMENT` / `X-PAYMENT-RESPONSE` (x402 **v1** names); our `@x402/core@2.24.0` emitted `PAYMENT-SIGNATURE` in tests (v2). The SDK selects encoding from the offer's `x402Version` — the implementer MUST verify (in SDK source) that the request-header name follows the offer's version, and the settlement parse must tolerate BOTH response-header names. A live 402 probe is possible only after the GitHub App is installed on a repo; until then this is a flagged integration risk, not an assumption.
- **Pre-payment guard (live probe):** an unpaid POST for a repo **without** the app returns plain 404 `{"detail":"The Ridges GitHub App is not installed on this repository. Install it here: https://github.com/apps/ridges-ai/installations/new"}` — the server refuses BEFORE payment, so no spend is wasted; the tool surfaces this message as-is.
- **No status API.** Ridges' own tracking is dashboard-only (Live / Review / History). Status here = **watch GitHub for the PR** (the output IS a PR), via the public GitHub REST API.
- **Double-charge warning (their docs, matches our invariant):** if a payment settles but the task fails to start, the payment is recorded server-side — do NOT retry; contact support with the tx hash. Our `x402Fetch` already never re-pays; this extension adds the support-with-tx-hash wording to its surfaced message.
- **Network reality:** Ridges charges on **Base mainnet**. The extension works end-to-end only after the owner's mainnet flip (~2 weeks out); everything up to the paid retry (validation, 404 guard, offer decode against a mock) is testable now, and the in-test 402 server pattern covers the full flow without a chain.

## Architecture

One package `packages/fez-ridges` (`@fezchat/ridges`), two parts + a shared store:

- **Headless part** (`fez.parts.headless`): the `ridges_dispatch` agent tool, the `/ridges <issue-url>` command (`registerCommand`), and the PR poller (`registerScheduledTask`).
- **GUI part** (`fez.parts.gui`): the jobs pane per the approved mock (`ridges-mock.html`) — the bounty rail, live/done sections, empty state — as a **mount-model** nav view (own React, standard JSX) with a **CSS module** (exercising the newly wired `fez pack` → `dist/gui.css` → loader-injection path).
- **Job store:** an append/update JSON in the extension's data namespace, mirrored to `~/.fez/extension-data/fez-ridges.json` for the gui (the wallet's mirror pattern; STORAGE_NAME = the installed package name, the lesson of the wallet's rename bug).

### Money: reuse, structurally

`fez-ridges` depends on `@fezchat/wallet` via `file:../fez-wallet` (both publish later in one batch). The wallet grows a small **exported** surface (today it's internal to `mcp.ts`):

- `x402FetchRaw(deps, args) → { kind: "response", status, bodyText, headers } | { kind: "paid", status, bodyText, txHash?, usd } | { kind: "refused" | "ambiguous", message, usd? }` — the existing flow returning a STRUCTURED outcome; the string-returning `x402_fetch` tool becomes a formatter over it, behavior byte-identical (existing tests must keep passing unmodified).
- `makeX402Deps(persona)` — the deps factory `mcp.ts` already builds, exported.

Every cap, consent round, record-before-retry and never-pay-twice guard stays inside the wallet where it is already reviewed and tested. Ridges passes `maxUsd` (default from its own config, `ridges.maxUsd`, default **5**) and consumes the outcome.

### The job record

```ts
interface RidgesJob {
  id: string;            // ridges issue_id when the response yields one, else the dispatch ts
  ts: string;            // dispatch time
  persona: string;       // who dispatched (identity-gets-a-face in the pane)
  issueUrl: string; repo: string; issueNumber: number;
  title?: string;        // issue title, fetched best-effort from GitHub
  usd?: number; txHash?: string;
  status: "working" | "pr-open" | "merged" | "closed" | "payment-unclear" | "refused";
  prUrl?: string; prNumber?: number;
  updatedAt: string;
}
```

`refused` rows (never-paid: bad URL, app not installed, cap/consent refusal) are kept briefly for the pane's honesty but carry `usd: undefined` — no money moved. `payment-unclear` mirrors the wallet's ambiguous outcome and includes the support wording.

### Dispatch flow (`ridges_dispatch({ issueUrl, maxUsd? })` and `/ridges <url>`)

1. Parse/validate: `https://github.com/<owner>/<repo>/issues/<n>` only (reject PRs, non-GitHub, garbage) — before any network.
2. Best-effort fetch the issue title (public GitHub API; failure → proceed untitled).
3. `x402FetchRaw(POST product.ridges.ai/v1/issues, { github_issue_url })`:
   - non-402 response (e.g. the 404 app-not-installed) → surface `detail` verbatim + the install link; record a `refused` row.
   - refused (cap/consent/maxUsd) → surface the wallet's message; `refused` row.
   - paid → parse `issue_id` from the body, record `working` with usd/txHash; the 47040 receipt is already published by the wallet.
   - ambiguous → `payment-unclear` row; message = wallet's do-not-retry wording + "contact Ridges support with the tx hash".
4. Mirror the job store after every write.

### The poller

`registerScheduledTask` every **90s** while any job is `working` or `pr-open` (idle otherwise): for each open job, `GET https://api.github.com/repos/<owner>/<repo>/pulls?state=all&sort=created&direction=desc&per_page=30` (unauthenticated, one call per repo per tick, `If-None-Match` ETags respected; on 403 rate-limit, back off to the reset time). A PR **matches** a job when its title/body/head-branch references `#<issueNumber>` (`fixes #N`, `closes #N`, `(#N)`, or branch containing `issue-N`/`N-`) — first match wins, recorded permanently on the job so a later rescan can't rebind. Transitions: match found → `pr-open`; PR merged → `merged`; PR closed unmerged → `closed`. Private repos are out of scope for v1 (the poller notes "repo unreadable — private? add a token later" on 404).

### The GUI (per the approved mock — the visual spec)

Mount-model nav view `{ glyph: "⛏", label: "ridges" }` (own React via `createRoot`, disposer). Styling via a **CSS module** with the mock's classes (bounty rail, spark, ghost sockets, faces); fez tokens by `var(--…)` reference — no hex. Sections: page-head with facts (`N live · N merged · $X this week` from the store + `network · asset` from the wallet's mirrored `x402Meta` via… the wallet's storage is another extension's namespace, unreadable — instead the ridges HEADLESS side mirrors `{network}` into its own store at dispatch time; the pane shows the last-known network badge, dimmed "unknown" before any dispatch). Rows exactly as mocked: agent face (`@fezchat/ui` `<Avatar pk>` when `api.client`/roster resolves the persona's pk, else the initial block), issue node linking to GitHub, the rail with price, PR socket/node, status line, meta (time, receipt glyph is decorative-linkless in v1). The `+ dispatch` input sends `/ridges <url>` via `api.client.sendChannelMessage` into the current scope's channel (the honest v1 — the command path does the money work through an agent); the hint says so. Empty state per the mock. Reduced-motion: static spark.

## Config

`~/.fez/extension-data/fez-ridges.json` `prefs` subtree (gui-writable seam): none needed in v1. Tool-level: `maxUsd` arg (default 5). No new permissions beyond the manifest: `network:product.ridges.ai`, `network:api.github.com`, `read:channels`, `publish`, `ui`.

## Out of scope (v1)

Alpha-stake credits, rerun-with-context (the pane shows a dead "rerun" affordance only if free), private-repo tokens, a Ridges status API (none exists), pane-native payment (dispatch always routes through an agent + the wallet's consent), mainnet e2e (blocked on the owner's flip; do a watched first live dispatch then).

## Done when

- `ridges_dispatch` + `/ridges` validate, refuse-before-pay on the 404 guard, pay via the wallet's structured outcome, and record honest rows for every outcome — with the wallet's existing 291-test surface untouched and green.
- The poller finds the PR for a dispatched issue in mocked-GitHub tests (match rules + transitions + rate-limit backoff pinned).
- The pane renders the mock faithfully from a seeded store (smoke test mounts + disposes; CSS module emitted by `fez pack` and injected by the loader end-to-end on a real install).
- Final review on a different model; the header-version risk explicitly verified against SDK source and tolerated on parse.
