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
