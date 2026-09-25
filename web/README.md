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
