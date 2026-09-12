# Sentry for Fez

One Sentry project → one repository → one existing Fez channel. A new issue opens a thread. Occurrence-count and status changes reply in that thread. Optional automatic investigation assigns your chosen agent once per new incident.

## Setup

Install `@fezchat/sentry` through Fez extensions and open its Sentry settings. Choose the Sentry region (`sentry.io`, `us.sentry.io`, or `de.sentry.io`), organization and project slugs, repository `owner/name`, destination channel, and agent. The agent must belong to the workspace and be attested by the account running the sentinel.

Paste a Sentry REST API token with **project:read** and **event:read** access to that project. Settings validate it against Sentry before storing it in the OS keychain (`fez-skill-env` / `fez-sentry.token`). It never enters relay configuration. This REST token is separate from the agent's existing Sentry MCP OAuth connection, which the agent uses for detailed investigation. Headless hosts can provide `FEZ_SENTRY_TOKEN` instead.

Enable the watch and explicitly opt into automatic investigation if wanted. Keep one sentinel running for this account/workspace. The background poll runs every 60 seconds. Settings are encrypted to the account on the relay; each settings save starts a fresh baseline. Existing issues never generate automatic backlog work. Changing the destination establishes a new baseline and cannot reply into the previous channel.

## Investigation contract

New unresolved incidents first seen after the baseline ask the selected agent to inspect Sentry, use an existing authorized checkout of the configured repository, reproduce the failure, fix the root cause, and run regression and repository checks. The requested output is a **draft pull request** in that repository and a link in the incident thread. Missing access, a missing checkout, unavailable tooling, or failed reproduction must be reported honestly. The request never authorizes merging, deployment, production changes, or another repository.

Repeated alerts, resolutions and regressions update the existing thread and do not assign another automated investigation. Compact title/count/status/link summaries are shared; raw stack traces and event payloads remain in Sentry. Imported text is labeled untrusted and cannot add agent mentions.

## Limits and failures

The bridge polls [organization issues](https://docs.sentry.io/api/events/list-an-organizations-issues/) filtered by the resolved project ID, including resolved and ignored issues. It follows [Sentry's pagination cursors](https://docs.sentry.io/api/pagination/) across a 90-day activity window, up to 20 pages / 2,000 issues per poll. An incomplete scan, missing pagination, malformed response, wrong-project issue, timeout, or rate limit produces an error instead of advancing the baseline. Older activity outside the window is not backfilled; an old issue that later enters the window may be posted but never automatically investigated.

Requests time out after 10 seconds, with a 45-second scan budget. Failed polls retry on subsequent scheduled runs; rate limits honor `Retry-After` with a bounded 1–15 minute pause. Runtime errors are prefixed `fez-sentry` in sentinel logs; settings report connection and save failures immediately. Source observations are persisted before publishing, and retries reuse signed delivery IDs after uncertain relay acknowledgements or failed state saves. Changing investigation settings preserves existing thread roots and suppresses pending automatic tasks.

State is local extension storage, scoped by account, relay, Sentry project, repository, and destination channel. Use one sentinel for that binding; cross-machine polling is not coordinated. Removing extension storage establishes another baseline. Already published history stays on the relay.

## Development

### Report Fez's own Node crashes

The optional Node preload is separate from the incident watcher. It activates only when explicitly loaded **and** `FEZ_SENTRY_DSN` is set. It reports uncaught exceptions, including unhandled rejections in Node's default mode. It preserves fatal exit behavior. Handled errors logged by application code, child processes launched without the preload, the React UI, and Rust crashes are outside this first version's coverage.

Create `packages/fez-sentry/.env.local` (git-ignored) with your project DSN:

```dotenv
FEZ_SENTRY_DSN=https://PUBLIC_KEY@INGEST_HOST/PROJECT_ID
FEZ_SENTRY_ENVIRONMENT=development
```

From the repository root:

```sh
npm run build --prefix packages/fez-sentry
npm run test:connection --prefix packages/fez-sentry
node --env-file=packages/fez-sentry/.env.local --import=./packages/fez-sentry/dist/instrument.mjs dist/cli.js --version
```

Replace `--version` with the Fez command to monitor, or replace `dist/cli.js` with the desired Node entry point. Optional `FEZ_SENTRY_RELEASE` identifies the build. The connection check sends a synthetic **Fez Sentry connection test** error and verifies an HTTP success acknowledgement; it fails on rejection or timeout. It does not verify the incident watcher or agent investigation.

Reporting retains error messages and stack locations. It excludes user/request data, console breadcrumbs, source lines, variables, attachments, hostname and contextual payloads. It scrubs matching environment credentials, Nostr private-key strings, 64-character hex keys and URLs from messages; arbitrary sensitive text inside an error message can still remain. Tracing and log collection are disabled. A deleted or unavailable Sentry destination does not prevent Fez from running; remove the DSN or preload to disable reporting. Changing or deleting a temporary project requires no code change.

### Extension checks

```sh
npm run build --prefix packages/fez-sentry
npx tsc --noEmit -p packages/fez-sentry/tsconfig.json
cd packages/fez-evals && npx vitest --run tests/sentry-bridge.test.ts tests/sentry-gui.test.ts tests/sentry-reporting.test.ts
```
