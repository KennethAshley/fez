# Mining workspace implementation plan

**Goal:** Unify Mining and its channel while retaining the full subnet catalog and persistent miner management.
**Architecture:** Existing native channel UI gains generic extension tabs/summary and a side pane. Signed channel metadata binds Mining by stable ID. Existing CLI and agent identities remain the execution boundary.
**Tech Stack:** TypeScript, React through the extension host, Nostr, Vitest and Playwright; no new dependencies.
**Spec:** docs/superpowers/specs/2026-09-10-mining-workspace-design.md
**Global Constraints:** Work only in .worktrees/mining-workspace on codex/mining-workspace. No live mining or messages, no push/release, no unrelated edits. Plain commits without trailers. Preserve current testnet/approval/secret gates.

- [x] Task 1 — Stable channel selection and duplicate prevention. Files: fez-client/src/index.ts, protocol/channels.ts, Desktop ManagePane.tsx, focused evals. channelsFrom(source?) lists all when omitted and exposes source/archived/visibility. ensureChannel(spec.id) resolves an existing ID first and preserves omitted metadata/source/visibility. createChannel trims, rejects empty names and reuses existing case-insensitive names. Creation UI says Open existing channel on matches. Checks: client/protocol evals for rename, preservation and reuse.
- [x] Task 2 — Generic host workspace and pane. Files: extension-api/src/gui.ts, desktop/gui-extensions.ts, App.tsx, App.css, host eval/browser tests. registerNavView opts.channelWorkspace has getChannelId(), tabs [{id,label,render}], summary render receiving openTab. Optional openChannel(id) and openPanel(title,render). Nav and channel open same native Activity; custom tabs keep chat draft mounted. openThread navigates across views. Pane owns disposal. No mining literals. Checks: type/mirror gates, browser navigation and pane.
- [x] Task 3 — Mining binding and persistent threads. Files: mining/workspace.ts, thread.ts, state.ts, cli.ts, headless.ts, persona-post.ts as needed, focused evals. Pure shared binding finder uses miningWorkspace marker. Explicit UI binding only. Background resolves bound channel; no ensure-by-name. thread ensure CLI creates/reuses a persona-authored root and persists channel/root together, serialized per operation; legacy roots are adopted only after channel validation. Checks: unlinked silence, rename/archive, thread reuse and author via fakes/local relay.
- [x] Task 4 — Mining screens. Files: mining/gui.tsx, submission-gui.tsx, persona-skill.ts as needed, GUI evals. Setup links/creates channel; tabs expose fleet/history and full catalog; summary opens launch. One pane reuses existing MinerCard/SubmissionPanel. Threads offer Manage. Enable mining before setup, offer existing/dedicated persona, retain capability on stop. Checks: GUI tests, screenshots, unchanged launch gates.
- [x] Task 5 — Integrate and review. Run root build/typecheck/evals, mining package suite, relevant Playwright flows. Review complete diff, fix findings, fetch main and check integration without disturbing other worktrees. Commit locally, leave ready for testing/merge.


## Completion — 2026-09-10

Implemented in `codex/mining-workspace`, rebased onto main `946bc09`. One App.tsx conflict was resolved by keeping main's history status/retry UI inside native Activity alongside the workspace tabs. Review findings on archived channel restoration, agent tool loading, stale extension callbacks, and per-workspace thread history are closed.

Verification on the rebased code:
- Full build: core + 45 packages; root, Desktop and Mining typechecks pass.
- Full eval gate: 1,630 passed, 3 skipped.
- Mining package: 172 passed, 7 skipped, using a temporary test home.
- Integrated browser flows: 2 passed; screenshots inspected.
- Changed TypeScript lint, Desktop CSS lint and diff check pass.

No live mining, wallet actions, uploads, user messages, application replacement, push or release was performed. The worktree and local commit are retained for GUI testing and a later merge.

Known recovery limit: unindexed legacy roots are searched within the latest 500 persona messages. Recorded roots survive relay/channel switches without that lookup. Incomplete reads fail visibly before a new root can be posted.
