# Desktop-owned agent lifetime implementation plan

**Goal:** Make the desktop the sole owner of local agents and background integrations while preserving the optional headless sentinel.

**Architecture:** Keep agent/protocol logic in TypeScript. Rust owns local process startup, restart, stop, restoration, and app shutdown. Reuse the sentinel's extension task host in a bundled app-managed worker that never summons agents. Closing the window keeps the app alive; explicit Quit confirms stopping local work.

**Spec:** [Approved lifecycle recommendation](../research/2026-09-11-buzz-agent-lifetime.md). The user approved this design with “do that” and subsequently requested Ditto publication first.

**Constraints:** Preserve existing keys, permissions, workspace boundaries, active configuration, and unsigned drafts. Do not send test Slack messages. Do not publish a new desktop release without a release request. Existing TypeScript session idle reaping remains unchanged. Keep unrelated changes intact.

## 1. Publish Ditto — complete

- [x] Build/check package and desktop; run full eval gate (2,157 passed, 8 skipped).
- [x] Commit only Ditto, its evals, catalog and publishing entries; fast-forward main to `cbacf874f9b43a445c32023abde68153dde82201`.
- [x] Publish `@fezchat/ditto@0.1.0`; verify exact-version public metadata and SHA-512 of downloaded tarball. The package-list endpoint initially cached a 404; exact-version and tarball endpoints are live.

## 2. Share the background extension host — complete

- [x] Extract existing scheduled-extension loading, workspace refresh and ticks from sentinel into one module, preserving `refreshWorkspace` export compatibility.
- [x] Add bundled desktop worker entry: resolve identity locally, connect relay, load permitted tasks, report readiness, await `start` on stdin before running tasks. Exit if stdin closes or parent dies. It never writes `sentinel.pid` or registers agent/notification/reminder watchers.
- [x] Keep headless sentinel behavior via the same host. Refuse headless startup while a verified desktop owner is active; use shared background ownership to avoid duplicate task hosts.
- [x] Add evals for delayed activation, task non-overlap, workspace authority, parent/control shutdown and no summons; build the worker and include it in the desktop bundle/version gate.

## 3. Native process ownership and migration — complete

- [x] Introduce `start_desktop_runtime(owner, relays)` to prepare the worker, migrate only the recognized legacy launchd sentinel with backup/rollback, activate background tasks and restore previously enabled local agents. New installs need no launchd sentinel.
- [x] Serialize spawn/stop/restart and shutdown. Track process groups for newly created children, verify persisted PID receipts before adoption/signalling, retain restoration records on Quit, and remove them on explicit Stop. Preserve channels/repo/line.
- [x] `spawn_agent` remains the shared command. Normal calls reuse a live local instance; `manual: true` performs explicit replacement when needed. Both automatic and explicit callers use it without a sentinel PID shortcut.
- [x] Add native Quit confirmation/accept command and tray controls; window Close hides, actual confirmed Quit stops app-owned local agents/extensions and descendants. Add SIGTERM cleanup to the TypeScript agent.
- [x] Add native tests with real isolated subprocesses for reuse, restart, shutdown, PID safety, restoration and failed migration rollback.

## 4. Desktop lifecycle UI — complete

- [x] Start the summon subscription only after `start_desktop_runtime` succeeds. Surface startup failures. Reconcile native runtime status while the app is alive; closing/hiding the window does not dispose it.
- [x] Remove sentinel deferral from summons/reminders. Route all restarts through native `spawn_agent` replacement instead of frontend kill-then-start sequences.
- [x] Persona save keeps active work running and reports restart required when launch configuration changed. The existing profile restart button applies the change.
- [x] Show native Quit request as a clear confirmation: local agents/integrations stop; Keep running cancels; Quit and stop local work invokes `confirm_desktop_quit`.
- [x] Update affected evals and lifecycle documentation.

## 5. Integrated validation and local migration — complete

- [x] Review the combined lifecycle changes and fix concrete findings. Native target: 112 passed, 1 ignored. Focused startup/admission/lifetime/refresh: 19 passed; native bounded-command/cleanup: 5 passed. Readiness fixtures now await actual agent startup instead of checking signal handlers.
- [x] Run root/desktop/sentinel typechecks, required builds, focused native/eval tests and full eval gate. Final shared-tree evals: 2,189 passed, 8 skipped (257 passed files, 2 skipped), 104.91s; log `/tmp/fez-lifecycle-evals-final.log`. Native target: 112 passed, 1 ignored; log `/tmp/fez-lifecycle-native-final.log`. Core + 49 package build passed; bundled runtime is `0.84.2+svc22`. The sentinel-selection fixture now uses an isolated home directory, so the gate also passes with the desktop running.
- [x] Build/install the local desktop with a rollback copy. Installed `/Applications/Fez.app` with a verified local ad-hoc signature; rollback copies are in `/Applications/.fez-before-desktop-lifecycle-6oo1u92a`. The worker reached readiness before the legacy launchd sentinel was retired; `~/.fez/desktop-sentinel.plist` retains its backup. GitHub and Slack selection survived, both tasks are registered, and the worker has established relay/TLS connections with no logged errors. No test messages were sent.
- [x] Verify Start/Restart, window Close/reopen, explicit Quit/cancel, process cleanup and restore using isolated test state where possible; preserve the user's unsent draft. Native Start/replacement tests passed. Live manual Restart replaced Steph's PID and returned to running. Close and Quit cancellation retained every process. Confirmed Quit stopped the app, worker and all six agents, retained their intent records unchanged, and left the original relay PID 35367 running. Relaunch restored all six agents under app PID 67914, each in its own process group; channels, relay, owner and work context were retained. Steph's unsent `Yo` remains in the composer.
- [x] Record exact results and remaining release status. Ditto 0.1.0 is published from main commit `cbacf87`. Lifecycle changes are installed locally. The user subsequently approved committing and pushing the lifecycle, sidebar and completed extension alias fixes to main; no public desktop release is requested. Unrelated extension naming/alias fixes from the concurrent task were preserved and are included in this local build. The app remains open with all six agents and one background worker running.

The live macOS check found that Tao's native Cmd+Q/Dock path bypasses Tauri's `ExitRequested` ([upstream report](https://github.com/tauri-apps/tauri/issues/13778)). The app now adds `applicationShouldTerminate:` to the existing delegate and routes it through the same confirmation predicate. A native Objective-C dispatch regression test and the live Cmd+Q → cancel → confirm flow both pass. Existing delegate callbacks remain intact.
