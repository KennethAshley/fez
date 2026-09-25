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
