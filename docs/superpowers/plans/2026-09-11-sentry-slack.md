# Sentry and Slack Implementation Plan

> Implementation and review are complete. The user subsequently authorized local account testing, installation, and committing/pushing the verified changes. Keep the existing Loom improvements intact.

**Goal:** Bring Sentry incidents and approved Slack mentions into Fez tasks with durable thread mapping and correlated agent results.

**Architecture:** Two installable packages using the sentinel's background task host and isolated desktop settings. Share protocol-level task dispatch and replay protection in fez-client. Sentry polls the supported organization issues API; Slack uses Socket Mode. Credentials stay in the existing OS keychain slots.

**Tech Stack:** TypeScript, existing fetch/WebSocket support, existing host React, Vitest and local relay checks. The optional error reporter uses pinned `@sentry/node`; the responder itself uses fetch.

**Spec:** User-approved conversation: one Sentry project → one repo → one Fez channel; incident investigation with tests and a draft PR, merging left to the human. Slack accepts explicit mentions from approved users in one configured channel and returns progress/results in the same thread.

## Constraints

- Owner-configured sources and agent pubkeys; fail closed on invalid config, missing channels, unauthenticated events, or removed/banned agents.
- Imported text is external data; strip mention syntax before owner-signed publication. Only configured agents receive task tags.
- Persist prepared event timestamps before publication, reuse the same event ID on ambiguous publish retries, and keep source IDs mapped across restarts.
- Store state by owner + relay + source. Only the sentinel runs the bridges; current machine must remain awake.
- Repeated alerts update the existing incident thread; no new automated task on each occurrence. Begin with a baseline, not a backlog of automatic fixes.
- Slack only exports correlated responses from the assigned agent, never arbitrary Fez channel history. Bot events and unapproved users do not trigger work.
- No deployments, automatic merges, or new hosted service. Sentry needs event-read credentials; Slack needs a privately installed app.

## Task 1: Shared task delivery (root)

- [x] Add failing evals for replay after ambiguous delivery, source isolation, configured worker authority, and valid/forged correlated results.
- [x] Add `packages/fez-client/src/bridge-work.ts` with scoped config loading, approved worker/channel checks, durable `publishOnce`, and task construction. Reuse `workResult` and `WorkspaceState`.
- [x] Add optional `created_at` to the Nostr publish contract so retrying a prepared event preserves its ID on both existing hosts.
- [x] Run the focused evals and client typecheck.

## Task 2: Sentry responder (independent implementer)

- [x] Add parser/pagination/baseline/change/restart tests in `packages/fez-evals/tests/sentry-bridge.test.ts`.
- [x] Build `packages/fez-sentry`: API poller, durable incident mapping, background registration, isolated settings and README. Read current API docs before implementing network behavior.
- [x] Configure one organization/project, repository, Fez channel, selected agent, token, and automatic investigation toggle. Report failures visibly; never silently consume an undelivered incident.
- [x] Test first sight, repeated occurrences, status changes, failed publishing, invalid source responses and archived channels.

## Task 3: Slack bridge (independent implementer)

- [x] Add evals for workspace/channel/user checks, explicit mentions, bot loops, duplicate envelope/event delivery, thread preservation and safe result export.
- [x] Build `packages/fez-slack`: Socket Mode connection with reconnect, authenticated API calls, durable inbound/outbound mapping, background registration, isolated settings, app manifest and README.
- [x] Shared task contract is supplied by root; communicate interface needs before diverging. No changes to the catalog or shared files.
- [x] Cover reconnect, revoked configuration, failures and rate limiting. Run package typecheck/build and focused evals.

## Task 4: Integration and review (root + fresh reviewer)

- [x] Add both extensions to the desktop catalog and keep manifest permissions accurate.
- [x] Verify settings with DOM tests and bundled GUI smoke checks; verify real signed tasks/results against a local relay.
- [x] Review both packages and shared helpers; fix material findings.
- [x] Run root/package typechecks, full build, full evals and diff checks. Report actual live-account limitations and the settings path to activate.

## Progress

- Shared delivery, both adapters, isolated settings and catalog entries are implemented. Review findings are fixed and rechecked.
- Core + 48 packages build successfully. Root and affected package typechecks pass. Lint passes with 26 existing warnings. Both headless bundles import outside the repository.
- Full eval gate passed: 248 test files passed, 2 skipped; 2,145 tests passed, 8 skipped. Includes bridge authorization/replay, signed relay round trips, settings, optional reporting, and desktop-agent summoning coverage.
- Live Slack testing exposed a sentinel handoff bug: an already-running desktop agent was not watching the bridge channel. The sentinel now reads verified desktop process records and uses the existing signed takeover protocol when extending its channels.
- Assigned work now puts the actual answer in `fez_complete_work.summary`. Slack displays successful answers directly and labels blockers as failures. A real Slack mention returned a full three-item checklist in 17 seconds. A follow-up asking to expand “item 2” returned the correct expansion in the same thread in 6 seconds, confirming retained context.
- The disposable Sentry project accepted a synthetic ingestion test, which the user resolved. Automatic Sentry incident investigation remains unconnected because no REST read token was configured. The optional reporter is not enabled persistently; the local test DSN is ignored by git.
