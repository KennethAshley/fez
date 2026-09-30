# Fez public website

This Next.js app serves `https://fez.chat`. The public manual is a separate
app in `../web-docs`, served at `https://docs.fez.chat`.

## Develop and verify

Run `npm run dev`, `npm run types:check`, or `npm run build` in the app you
are changing. Each app has its own dependencies and lockfile. The website's
`next.config.mjs` redirects old `/docs` URLs to the manual, preserving the
page path.

After publication, run `node ../web-docs/scripts/check-public-pages.mjs` here. It checks
the manual and the Bazaar guide at `docs.fez.chat`. It
makes read-only HTTP requests; no agent jobs or chain operations run.

## Deployment boundaries

| Vercel project | Source directory | Domain |
| --- | --- | --- |
| `fez-web` | This directory as the upload root | `fez.chat` |
| `fez-docs` | `web-docs` within the repository/upload root | `docs.fez.chat` |

The Git-connected `fez-docs` project must have **Root Directory = `web-docs`**.
Setting it to `web` builds the marketing app under the docs domain and breaks
every manual page. For a CLI deployment, stage the manual inside a
`web-docs/` directory and upload its parent, preserving that same root setting.

Keep the two `.vercel/project.json` identities separate. Inspect the project,
source-file list, and built routes before promoting a deployment. Never
upload local `.env` files, private experiment records, or unrelated workspace
files. Existing environment settings stay on their respective Vercel projects.

The website's production hosting target is distinct from the chain network:
the current Bazaar integration uses **Bittensor testnet, subnet 553**. A site
deployment does not authorize model spending, specialist payments, or changes
to coordination rewards.

## Mac app page

`/app` restores the former desktop-app homepage, including the Mac download,
video tour, agent roster, and guide. It uses the shared site navigation and
existing showcase components. The main `/` route presents the early-access business decision-model direction.
The former Sidecar/network homepage is preserved at `/cli` (`/network` redirects there).

## Decision model page

`/model` presents the experimental Fez decision model and its recorded public
JevBench comparison. The shared header links to it from the homepage. This is
separate from the coordination judge and its historical testnet records.

The route is prerendered from `public/model/jevbench-public-001.json`; it requires
no browser data request or live subnet service. That file is a public snapshot
of `docs/data/jevbench-public-001.json` from `ooo-hq/fez`. Update the snapshot from
that source and rerun the checks when the recorded comparison changes; never
copy raw runs, private state, or model artifacts. The page exposes the same JSON
at `/model/jevbench-public-001.json` for inspection. Evidence timestamps describe
the experiment, not the time a visitor opens the page.

From this directory, run `npm ci` for a fresh checkout, then `npm run dev -- --port 4175 --hostname 127.0.0.1` and open <http://127.0.0.1:4175/model>. Verify with
`npm run types:check`, `npm run build`, and the repository's `npm run evals`.
The intended production path is `https://fez.chat/model` in the existing
`fez-web` hosting project. Adding the route does not publish it automatically.

The page also presents the completed Bittensor **testnet subnet 579** rehearsal
from `public/model/testnet-round-001.json`, copied from the matching aggregate
record in `ooo-hq/fez`. It includes miner scores, requested allocations, observed
chain integers, and verification blocks. This is a recorded round on a reused
synthetic development benchmark, separate from JevBench. The participant counts
describe that one-host rehearsal; there is no live availability feed.

## Decision playground

`/playground` runs typed questions against **our Fez checkpoint only**. It has
editable state/questions, four example requests, probability distributions,
raw JSON, and a copyable API request. There is no hosted Kev/Jev fallback,
sample response, or automatic request on page load.

Create `web/.env.local` with the following settings. The inference address is
the complete URL of your Fez model server's SystemOne route, not a browser URL.

```dotenv
FEZ_DECISION_API_URL=http://127.0.0.1:8009/v1/systemone
FEZ_DECISION_MODEL=fez-0.8b-experimental
FEZ_DECISION_LABEL="Fez 0.8B · experimental"
FEZ_DECISION_API_KEY=replace-with-the-model-server-bearer-key
```

Keep these settings server-side; do not use `NEXT_PUBLIC_` names. With no
endpoint configured, the editor remains usable but Run is disabled and the API
returns 503. Provider failures never produce substitute answers.

Fez checkpoints use the existing `kev.serve` HTTP server from the version pinned
in the [model repository](https://github.com/ooo-hq/fez/blob/main/requirements/model.txt).
Supply your own trained Fez checkpoint; the experimental checkpoint is not a
public model download. On a model host with that repository's Python environment
and cached base model, install the serving extras:

```bash
python -m pip install fastapi==0.141.1 uvicorn==0.53.0
export FEZ_CHECKPOINT=/absolute/path/to/your/fez-checkpoint
export KEV_API_KEY=replace-with-the-same-model-server-bearer-key
test -f "$FEZ_CHECKPOINT/head.pt" && \
  KEV_BACKEND=torch KEV_DTYPE=fp32 KEV_PREFIX_CACHE=0 KEV_CUDA_GRAPHS=0 \
  KEV_FUSED=0 KEV_DATE_FACTS=0 KEV_MERGE=1 KEV_LORA_SCALE=1 \
  python -m kev.serve --run "$FEZ_CHECKPOINT" --fallback "$FEZ_CHECKPOINT" --port 8009
```

Verify the checkpoint hash and saved calibration before connecting it. The
server binds loopback. For a deployed website, configure a reachable HTTPS
inference endpoint with authentication and request/concurrency limits; Vercel
cannot reach your laptop's loopback address. Never expose a development model
server directly. No GPU hosting is provisioned by the website.

`GET /api/playground` returns public configuration only. `POST /api/playground`
accepts `{ state, model, questions }` using the TypeSafe-compatible question
types `noul`, `choice`, and `score`. It allows 1–8 questions, 1–16 options per
question, and a 32 KB request. It validates complete answer distributions and
model identity, uses a 60-second provider timeout, and does not cache or log
request/response bodies. The browser's API view generates a request for its
current origin. Server credentials and upstream errors are never forwarded.

Run the website typecheck/build and
`npx vitest run tests/website-playground.test.ts` in `packages/fez-evals`.
Verify a real Fez response, JSON/API views, malformed input, cancel/retry,
disconnected endpoint behavior, and a 390px mobile layout.

The interaction is inspired by [Kev's playground](https://github.com/jaredpalmer/kev/tree/main/playground).
The UI and examples here are original; the model-serving dependency remains
Jared Palmer's Apache-2.0 Kev implementation.

## Business positioning

The homepage preserves the approved hero copy and distinguishes proposed customer
training and deployment from the experimental pipeline. Its contact CTA uses the
existing Discord community invite (`lib/shared.ts`); there is no customer signup
or data-upload form. A dedicated business contact destination remains a product
decision. Research stays at `/model`, with the original aggregate evidence intact.
The playground, agent network, Mac app, extensions, artifacts, and manual remain
available. Homepage canonical, Open Graph, and Twitter copy share the positioning.
This update does not change Vercel configuration or publish a deployment.

## Homepage visual design

The light pages (home, research, playground, CLI) share `components/light.module.css`
(drifting gradients, grain, scanlines, a phosphor terminal look) plus
`LightBackdrop`/`SiteFooter` from `components/site-footer.tsx`. The header carries
research and playground; everything else is in the one footer list,
`FOOTER_LINKS` in `components/site-header.tsx`.

The homepage ticker and the testnet replay terminal are built at request time
from `public/model/*.json`; every number shown is in those records. The hero
decision instrument (`app/(home)/live.tsx`) is illustrative and labeled so.
All looping motion stops under reduced-motion preferences, and the instrument
server-renders its settled first frame.

## Training dashboard (development)

`/train` is an authenticated UI for the model repository's coordinator API. It
uses the existing Fez Supabase project, isolated by the backend's `fez_training_*`
tables and private `fez-training-data` / `fez-training-models` buckets. This web
app does not create tables, apply migrations, assign workers, or host inference.
No backend or dashboard deployment is implied by this code.

Configure these public browser settings in the website environment before building:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-existing-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-public-publishable-key
NEXT_PUBLIC_FEZ_TRAINING_API_URL=https://your-training-coordinator.example
```

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is a legacy fallback. Never put a Supabase service
role or secret key in a public environment variable. Missing/invalid configuration
renders a disconnected state with no signup form, uploads, or simulated jobs.
Keep the actual project URL and publishable key configurable; do not copy service
credentials into this repository.

Deployment preparation (not performed by this change):

- Apply the coordinator-owned SQL/storage migration to the existing project.
- Configure Supabase email-link authentication and allow the exact `/train`
  return URL on each approved website origin (including localhost for testing).
- Deploy/configure the coordinator with its own server-side credentials and
  approved workers. Allow the website origin in coordinator CORS; support
  Authorization and Content-Type headers, GET/POST/OPTIONS requests.
- Allow direct signed Storage PUTs with Content-Type and x-upsert headers.
- Supply the three public website variables, rebuild, and test with authorized
  synthetic data before accepting customer datasets.

The browser checks three independently prepared JSONL splits (up to 128 MiB
apiece), IDs, source groups, prompt overlap, labels, and family coverage before
creating a job. This is a convenience check; the server is authoritative and
checks again. It cannot detect semantic duplication or establish data rights.
An explicit checkbox records permission to export training data to approved
workers, who can read and retain it. This is not confidential compute.

The UI creates a job, uploads raw files directly to private signed Supabase URLs,
and submits for validation. Session bearer tokens go only to the coordinator.
Failed uploads remain recoverable: reselect the original three files and use
Resume missing uploads; `{uploaded:true}` slots are skipped, never overwritten.
Retry submission handles the case where files arrived but submission did not.
Cancel this job frees a stalled uploading job's active quota (five per account).
Stop cancels local validation/network work, not a remote job already submitted.

Jobs are refreshed every ten seconds while active; network failures retry at
thirty seconds. The UI distinguishes operator approval, queueing, training,
evaluation, accepted delivery, and no qualifying model. Signed download links
are fetched on demand only for accepted completed jobs and are not persisted.
Artifacts do not include a hosted inference endpoint. No weights are shown as
payments or earnings.

Verification: `npm run types:check`, `npm run build` in `web`, plus
`npx vitest run tests/website-training.test.ts` in `packages/fez-evals`.
Tests use synthetic data and mocked HTTP; no customer files, live Supabase
project, or chain transactions are needed. The authenticated UI was also checked
against a temporary localhost-only synthetic auth/coordinator fixture. That
fixture is not part of the application or deployment.
