# Google as a fez Connection — official endpoints, bridges, and the verdict

*2026-09-05 research. No `docs/superpowers/research/` convention existed before
this file; created it mirroring the specs naming (`YYYY-MM-DD-<topic>.md`).
Question: how does fez add Google (Drive/Gmail/Calendar/Sheets) with the same
sign-in flow as Linear? All probes run live 2026-09-05 with curl.*

## TL;DR

**Google hosts official remote MCP servers for Gmail, Drive, Calendar, Sheets,
Docs, Slides, Chat, and People — live today, speaking MCP OAuth discovery.**
Probed: `https://gmailmcp.googleapis.com/mcp/v1` serves
`/.well-known/oauth-protected-resource/mcp/v1` pointing at
`accounts.google.com`. No middleman exists on this path. The catch is not the
endpoint, it's Google's authorization server: **no DCR** — fez must ship its
own registered client (the GitHub bucket, not the Linear bucket) — and Gmail
scopes trigger Google's restricted-scope verification (annual CASA assessment,
~$540–1,800/yr). Drive via `drive.file` and Calendar/Sheets (sensitive scopes)
need only free verification. Every aggregator (Pipedream, Zapier, Composio)
puts the user's Google grant in the aggregator's database — exactly the hub
the connections spec rejects. **Verdict: official Google endpoints, phased —
Drive/Calendar/Sheets first (no CASA), Gmail when the assessment is paid for.**

---

## 1. Does Google host an official remote MCP server? YES

Announced May 2026 on the Workspace updates blog ("Agent tools and security
updates for Google Workspace developers",
https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html)
and at Cloud Next '26 ("more than 50 Google-managed MCP servers GA or preview",
https://cloud.google.com/blog/products/ai-machine-learning/google-managed-mcp-servers-are-available-for-everyone).
Docs: https://developers.google.com/workspace/guides/configure-mcp-servers and
https://docs.cloud.google.com/mcp/overview (which states the servers are
"compliant with the MCP authorization specification").

Endpoints (from the Workspace configure guide, confirmed live):

| service | endpoint | scopes offered (from live metadata) |
|---|---|---|
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1` | `mail.google.com`, `gmail.modify/compose/readonly/metadata` — **all restricted** |
| Drive | `https://drivemcp.googleapis.com/mcp/v1` | `drive`, `drive.readonly` (restricted), **`drive.file` (non-sensitive)** |
| Calendar | `https://calendarmcp.googleapis.com/mcp/v1` | `calendar` + granular calendar.* — sensitive |
| Sheets | `https://sheetsmcp.googleapis.com/mcp/v1` | `spreadsheets(.readonly)`, `drive(.readonly)` — sensitive |
| Docs | `https://docsmcp.googleapis.com/mcp/v1` | `documents(.readonly)`, `drive(.readonly)` |
| Slides | `https://slidesmcp.googleapis.com/mcp/v1` | `presentations`, `drive.file`, … |
| Chat | `https://chatmcp.googleapis.com/mcp/v1` | granular chat.* |
| People | `https://people.googleapis.com/mcp/v1` | contacts/profile |

Live probes (2026-09-05):

- `GET https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1`
  → **200**: `{"authorization_servers":["https://accounts.google.com/"],
  "bearer_methods_supported":["header"],"resource":"https://gmailmcp.googleapis.com/mcp/v1",
  "scopes_supported":[…gmail scopes…]}`. Note the metadata lives at the
  **path-appended** well-known (RFC 9728 path form); the root
  `/.well-known/oauth-protected-resource` 404s. The MCP SDK handles this form.
  Same result for drivemcp, sheetsmcp, docsmcp, slidesmcp, calendarmcp, chatmcp.
- Unauthenticated `POST initialize` → 200 (`serverInfo: "StatelessServer"`);
  unauthenticated `tools/list` → 200 with the full tool list. Tool *calls*
  require the Bearer token. So fez can even show "what your agent gets" from
  the live server without a sign-in.

Status and gating:

- **Developer Preview**: the Workspace MCP servers require the (free) Google
  Workspace Developer Preview Program
  (https://developers.google.com/workspace/preview) — enrollment is on the
  *developer's* Cloud project, once, not per user.
- The developer's project must enable both the underlying APIs (Gmail, Drive,
  …) and the MCP services (`gmailmcp.googleapis.com`, …) — one gcloud command,
  documented in the configure guide. End users enable nothing.
- No pricing documented; usage bills as ordinary Google API quota against the
  client's project (standard Google OAuth model).

Other Google MCP things, for completeness — none change the answer:

- **MCP Toolbox for Databases** (googleapis/genai-toolbox): self-run binary
  for databases; not hosted, not Workspace.
- **Firebase MCP**: local stdio via `firebase-tools`; not hosted.
- **Developer Knowledge API MCP** (docs lookup) and **Data Commons hosted
  MCP**: hosted but irrelevant to Drive/Gmail.

## 2. The catch: accounts.google.com is a shipped-client_id bucket

Probed live 2026-09-05, `https://accounts.google.com/.well-known/oauth-authorization-server`
(exists, 200 — so SDK discovery works) and `/.well-known/openid-configuration`:

- **`registration_endpoint`: absent — no DCR.** Google bucket = GitHub bucket:
  fez registers ONE OAuth client, ever; its id ships in the catalog.
- `code_challenge_methods_supported`: `["plain","S256"]` — PKCE fine.
- `token_endpoint_auth_methods_supported`: `["client_secret_post","client_secret_basic"]`
  — no `none`. **But** for Desktop-type clients the native-app doc marks
  `client_secret` **Optional** at the token endpoint, and Google's own guidance
  says installed apps "cannot keep secrets" — the secret is explicitly not
  confidential (https://developers.google.com/identity/protocols/oauth2/native-app).
  The `gcloud` and `rclone` precedent: both ship client_id+secret in public
  source. If a secret turns out to be required in practice, it's one more
  catalog data field, same custody story as the shipped client_id.
- Loopback `http://127.0.0.1:<port>` redirect: supported for macOS/Linux/
  Windows desktop clients (deprecated only for *mobile*) — fez's existing
  loopback flow works as-is.
- `grant_types_supported` includes `refresh_token` **and device_code** (the
  parked headless path exists when needed).

Two real accommodations beyond the GitHub bucket:

1. **`access_type=offline`**: Google only issues a refresh token when the
   authorize URL carries `access_type=offline` (and re-consent may need
   `prompt=consent`) — https://developers.google.com/identity/protocols/oauth2.
   The MCP SDK won't add these; fez needs an `extraAuthParams` catalog field
   (data) plus ~5 lines appending them to the authorize URL (one small code
   accommodation, same size class as `authServerUrl` for UR). Without it every
   connection dies after 1 hour.
2. **Client-type mismatch risk**: the configure guide documents only "Web
   application" clients with https redirect URIs (it was written for
   claude.ai/Antigravity). A Desktop client + loopback should mint identical
   scoped bearer tokens — the resource only checks scopes and that the
   client's project has the MCP service enabled — but this is the one thing
   the docs don't promise. **Verify by registering and running the spike
   before committing the catalog entries.** Fallback if Desktop is rejected:
   a Web client with `http://127.0.0.1` redirect (Google allows localhost
   redirects on Web clients for development) or the device flow.

### Google's verification wall (the actual cost of the no-middleman path)

Source: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
and the OAuth verification FAQ (support.google.com/cloud/answer/9110914).

- **Unverified app** requesting sensitive/restricted scopes: "unverified app"
  warning screen, 100-user cap, limited refresh-token lifetime (7 days while
  the consent screen is in Testing). Fine for Ken and early users, not for a
  product.
- **Sensitive scopes** (Calendar, Sheets `spreadsheets`, Docs, `drive.file` is
  not even sensitive): brand verification (2–3 business days) + data-access
  review with a demo video. Free.
- **Restricted scopes** (all Gmail scopes the MCP offers; Drive's broad
  `drive`/`drive.readonly`): all of the above **plus an annual CASA (App
  Defense Alliance) security assessment by a Google-empanelled assessor**,
  re-done every 12 months from the Letter of Assessment date. Tier 2
  self-scan is no longer accepted. Live market pricing 2026: TAC Security
  $540–1,800/yr; other labs $900–4,500
  (https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option,
  https://deepstrike.io/blog/google-casa-security-assessment-2025).
- Phasing consequence: **Drive (via `drive.file`), Calendar, Sheets, Docs need
  no CASA** — free verification only. Gmail (and broad Drive) is the paid,
  annual-treadmill rung. `drive.file` = agent sees files the user picks /
  files the app created, which is honest scoping anyway.

## 3. Hosted bridges/aggregators — all fail the "nobody in between" test

Every one of these terminates the Google OAuth grant **in their database** and
re-exposes tools over their own MCP endpoint. The MCP-OAuth token fez would
hold is a token *to the aggregator*; the Google refresh token lives with them.
That is the hub the connections spec explicitly rejects. Facts anyway:

**Pipedream** (probed live 2026-09-05, prior session):
`mcp.pipedream.net` root serves oauth-protected-resource metadata → auth
server `mcp.pipedream.com`; its `/.well-known/oauth-authorization-server`
advertises `registration_endpoint /api/oauth/register`, PKCE S256,
`token_endpoint_auth_method none`, refresh_token grant; a live DCR POST minted
client_id `dyn_Dyg8omkQUMpsYYvf`; end-user endpoint
`https://mcp.pipedream.net/v2` 401s with a proper Bearer challenge. So it is
a *technically perfect* MCP OAuth citizen — fez's flow would connect with zero
code. But: docs (pipedream.com/docs/connect/mcp) say connected accounts are
stored in a Pipedream project — **Pipedream holds the Google grant**; dev-mode
endpoints are `https://remote.mcp.pipedream.net/v3` keyed to *your* Pipedream
project. Pricing: free tier is dev-only (100 credits/mo); production Connect
is ~$99/mo + ~$2/external user + credits per tool call
(pipedream.com/docs/pricing, probed page was JS-shelled; figures from their
docs mirror). Google coverage: full (Drive/Gmail/Calendar/Sheets among 3,000+
apps). Google-verified (their production Gmail integration implies CASA), but
the user's consent screen says Pipedream, not fez.

**Zapier** (probed live 2026-09-05): `https://mcp.zapier.com/.well-known/oauth-authorization-server`
→ 200 with `registration_endpoint /api/v1/oauth/register`, PKCE S256,
`token_endpoint_auth_methods` including `none`, authorization_code +
refresh_token. Root protected-resource → 404 "protected resources are
available at specific endpoints" (per-user server URLs, provisioned in
Zapier's UI or via their OAuth onboarding). Credentials for Gmail etc. live in
the user's Zapier account (docs.zapier.com/mcp). Pricing: MCP calls bill as
Zapier tasks, ~2 tasks per successful tool call; free plan 100 tasks/mo ≈ 50
tool calls; paid from ~$19.99/mo (zapier.com/pricing; toolradar.com/tools/zapier-mcp/pricing).
Per-tool-call metering on someone else's meter.

**Composio**: `mcp.composio.dev` 301s to a marketing page (probed). Actual
pattern per docs: `https://backend.composio.dev/v3/mcp/<server_id>?user_id=…`
— server provisioned via *their* API key, end-user auth via Composio-managed
auth configs; tokens in Composio's cloud (docs.composio.dev/docs/mcp-overview).
Not a self-describing MCP OAuth endpoint a stranger can connect to; it's an
embedded-integrations product (Nango/Paragon are the same shape — B2B
credential vaults, not end-user MCP OAuth).

**Klavis**: `mcp.klavis.ai` doesn't resolve; `strata.klavis.ai` well-known →
404 (probed 2026-09-05); docs page is JS-shelled. Couldn't verify a live MCP
OAuth surface; hosted "Strata" product exists per their site. Immature or
API-key-gated — either way, same custody model, skip.

**Smithery**: `server.smithery.ai` well-known → 404 (probed). It's a registry/
gateway for *community* servers — for Google it would be hosting someone's
community bridge holding your grant. No.

## 4. Self-hosted bridge (own the middleman)

Shape: a Cloudflare Worker (`McpAgent` + `workers-oauth-provider`, the
cloudflare:build-mcp pattern) that is itself an MCP OAuth server (DCR, PKCE)
toward fez, and an OAuth *client* toward Google upstream; Google refresh
tokens encrypted in the Worker's KV/DO storage. Or
taylorwilsdon/google_workspace_mcp (README: streamable-http transport, OAuth
2.1 PKCE mode, 12 Google services / 120+ tools) run on a droplet.

Honest accounting: fez still needs the *same* Google OAuth client, the same
verification/CASA wall (the consent screen is fez's either way) — plus now
there's a server to run, secure, and pay for, holding every user's Google
refresh token. It's Pipedream with extra steps and worse security posture
than either Google-direct (no third copy of tokens) or Pipedream (their SOC2
vs a hobby Worker). Only justified if Google's endpoints lacked something
fez needs (e.g. Tasks/Forms, which the official set doesn't cover and
taylorwilsdon's does).

## 5. Direct-to-Google, no MCP server at all (local stdio)

The user runs e.g. `uvx workspace-mcp` (taylorwilsdon) locally as a stdio
server; it does Google OAuth itself and wraps REST. No middleman, works today.
But it's outside connections.ts entirely: fez's flow is
`McpServerHttp {url, headers}` handed to the harness; stdio servers manage
their own auth, their own token files (`~/.credentials/…json`, not keychain),
their own client registration (each user makes a Cloud project — the DX
Corsair was rejected for). This is the "paste a token" era with more steps.
Not a Connections story; at most a docs footnote for power users. The parked
REST-adapter rung stays parked: Google no longer *is* a REST-only service.

## 6. Verdict

Ranked against the spec's principles (no hub; keychain custody; per-service
difference is data, not code; zero-config preferred):

1. **Official Google Workspace MCP endpoints — do this.** Nobody between the
   user and Google; tokens in fez's keychain; Google's own tool definitions.
   Cost in fez: 4–8 catalog rows (gmail/drive/calendar/sheets, maybe docs/
   slides) each carrying `url`, `scope`, `clientId` (+`clientSecret` if
   required) — data — plus ONE small code accommodation: an `extraAuthParams`
   field appended to the authorize URL for `access_type=offline&prompt=consent`
   (~10–20 lines in connections.ts, same class as `authServerUrl`). One-time
   ops outside the repo: create fez's Cloud project, enable 8 APIs + 8 MCP
   services, enroll in Workspace Developer Preview, register the client,
   verify the brand. **Phase 1 (free): Drive via `drive.file`, Calendar,
   Sheets, Docs — sensitive-scope verification only. Phase 2 (paid): Gmail,
   $540–1,800/yr CASA, annual.** Pre-work: run the oauth spike against
   gmailmcp with a Desktop client to confirm loopback + secret-optional
   behave as documented (§2 risk).
2. **Pipedream row — the pragmatic bridge if Ken wants Google-in-fez this
   week with zero Google paperwork.** Zero code (their MCP OAuth is fully
   standard, DCR probed working); but Pipedream holds the Google grant,
   meters every call, and the consent screen isn't fez's. It's precisely the
   broker the spec forbids; if listed at all, label it "via Pipedream" so the
   custody difference is visible. Zapier same shape, worse metering (~50 free
   calls/mo).
3. **Self-hosted CF Worker bridge — no.** Same Google verification wall as
   option 1 plus a token-holding server to operate. Only revisit if the
   official endpoints miss a needed app (Tasks, Forms).
4. **Local stdio (community server) — not a Connection.** Docs footnote at
   most; per-user Cloud projects is the DX this whole feature exists to kill.
5. **Wait — no.** The endpoints are live, standard, and probed; Developer
   Preview is the only asterisk, and it's a free enrollment on fez's project.

The one-line summary: **Google turns out to be the GitHub bucket with a
verification fee, not a missing service — ship the official endpoints,
`drive.file`+Calendar+Sheets first, Gmail behind the CASA check.**
