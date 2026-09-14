# Parallel Browser Release Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Independent packaging
> and MCP-target tasks use superpowers:dispatching-parallel-agents; serialize native builds.

**Goal:** Cancel waiting turns, run visible browsers concurrently, and build signed normal Fez with CEF.

**Architecture:** Preserve extension-owned browser UI and Browser Use MCP. Rust owns native sessions, queues, tokens, input and cursors. Reuse the pinned CEF staging process for reproducible desktop builds.

**Tech Stack:** TypeScript, Vitest, Tauri/CEF, Rust, AppKit, macOS codesign.

**Spec:** ../specs/2026-09-13-parallel-browser-release-design.md

## Global constraints

- Four visible browsers maximum, one driver per browser, one browser per persona per Fez turn.
- Preserve uncommitted browser work and the current branch.
- Full app uses system secret storage; lab alone uses mock storage.
- Exact pins: Tauri c8c75b1f7f43e7cb1e7d773ed2f6f96fad2fe975; plugins 1423992771e0b57582ca3b06a6adc46ec26aa784.
- Never weaken visibility, epoch, origin, socket or attachment checks.

## 1. Cancellable native queue

- [x] Add a regression: queue Quill/Drift, cancel only Drift, assert Quill still drives, Drift cannot rejoin that message, and a later message can join.
- [x] Implement `Queue::cancel(request: &str, persona: &str) -> Result<(), String>`; preserve completed-batch admission guard.
- [x] Add `waitingEntries: [{request,persona}]` alongside existing `waiting` in state. Owner command accepts optional request/persona only for cancel; UI sends the exact entry and filters events by surface ID.
- [x] Run Rust queue checks and owner UI evals.

## 2. Independent native sessions and browser panes

- [x] Extend native regression to open two surfaces, observe distinct persona drivers simultaneously, and prove takeover/close/cancellation affect only the intended surface.
- [x] Change Host current surface to keyed surfaces. Scope cursor and AppKit monitor maps by ID. Resolve owner identity from its view label. Bound connection workers and serialize input per surface.
- [x] Publish atomic version-2 persona catalogs; bind a persona's turn on observation and remove its reservations from other queues.
- [x] Add New browser/Close pane UI using repeated mountBrowser slots and responsive visible panes; preserve one-pane command behavior.
- [x] Run browser UI evals, build desktop, stage lab and run actual native regression.

## 3. MCP target selection (delegated)

- [x] Add failing tests for version-2 listing/routing, stale target refusal, sibling updates and legacy descriptors.
- [x] Extend the existing browser_use tool with list and target. Send native id and keep frame identity tied to successful observation.
- [x] Run MCP tests/typecheck/build; review returned diff.

## 4. Reproducible signed packaging (delegated)

- [x] Test build configuration generation against fixture checkouts.
- [x] Add pinned-source bootstrap and normal desktop release staging, preserving app identity/updater/bundled runtime.
- [x] Configure full native host with SecretStorage::System and separate cache; retain test-only debug controls.
- [x] Produce local release app, verify nested signing, and notarize if credentials are available. Record any concrete external blocker.

## 5. Integration gate

- [x] Run root `npx tsc --noEmit`, desktop/MCP checks and `npm run evals`.
- [x] Run native tests after all code changes, then inspect real side-by-side panes and themed cursors in Fez.
- [x] Verify artifact signatures and report exact artifact path, test results, and remaining release requirements.

## Verification notes

- Native unit suite: 130 passed, 1 ignored with `--features tauri/custom-protocol` (the build's bundled-origin configuration). Running the staged config without that dependency feature incorrectly selects a missing dev URL.
- Initial actual CEF multiplex regression passed: two drivers and cursors, independent takeover/stop, exact waiter cancellation, isolation and cleanup. Final regression also checks failed admission can choose another browser.
- Review fixes: commit target routing only after queue admission; expire input permission before a timed-out callback can dispatch; preserve later waiting requests from the current persona.
- Fresh installs seed the actual Browser and Computer use archives before opening the UI; preserve customized installs/uninstalls and clean partial failed seeds. MCP Node provisioning reuses the managed runtime before agent launch.
- Signing certificate is available. Configured notarization/updater credentials are absent; local signed app verification must not be described as notarized or published.

### Final gate and signed artifact

- Root, desktop, and Computer use typechecks pass. Full quiet gate: **2,493 passed, 11 skipped** across 292 passing files (5 optional files skipped). The earlier relay-start 1-second poll failed under simultaneous native compilation; its isolated rerun and final quiet full gate pass.
- Final native CEF regression passes (10.39s): parallel driver/cursor input, waiter cancellation, failed target admission recovery, owner takeover/stop, origin isolation, close/reload cleanup.
- Signed release build succeeded with normal `com.fez.desktop`, version 0.4.39. Retained at `packages/fez-desktop/src-tauri/target/native-browser/verified-2026-09-13/fez.app` (723.71 MiB). Verified app, five CEF helpers, six byte-identical signed agent binaries, and runtime/JIT entitlements. Notarization skipped because credentials are unavailable; updater artifact signing disabled only for this local verification build.
- First-launch crash fixed: bundled-extension seeding now preserves the same package under an existing legacy ID (e.g. `fez-browser`), reusing the installer's package identity lookup. A regression preserves both the installed manifest and custom data; native suite is now 130 passed, 1 ignored.
- User approved launching the signed app against the existing Fez profile, including configured agents/integrations. The earlier approval block is resolved.
- **Awaiting owner interaction:** the signed app's initial page is canceled before asset serving while macOS waits for access to the existing `Chromium Safe Storage` Keychain item. `securityd` at 17:59:58 confirms it is displaying a prompt for the signed Fez PID; the item's prior ACL belongs to the earlier local `cefsimple.app` prototype. Computer Use refuses access to `com.apple.SecurityAgent`, so the owner must enter their password in the system dialog and choose Allow. An input request is pending; no Keychain ACLs or security policies were changed.
- Controlled diagnosis: fresh cache, Developer ID vs ad hoc, and release vs debug do not change the failure. An isolated lab with System storage gives an empty `about:blank` document; changing only that disposable lab to Mock passes the complete native test (11.0s). Production retains System storage. Original browser cache was restored; the empty diagnostic cache was retained separately.
- Chromium's `-67030` signature log pair is emitted by background signature metrics. The running app passes macOS dynamic and static signature checks; that log is not evidence the signed bundle is invalid.
- Latest normal signed artifact: `packages/fez-desktop/src-tauri/target/native-browser/verified-startup-fix/fez.app` (723.70 MiB). It is running through normal macOS app launch while waiting on the Keychain prompt. Temporary instrumentation exists only in disposable build stages/copies; production code has no diagnostic remote port.
- After Keychain approval, reload the app and finish the real side-by-side pane/queue/cursor check. Notarization credentials remain unavailable; no release was published.

- Post-startup-fix full gate: **2,493 passed, 11 skipped** (`/private/tmp/fez-parallel-evals-post-startup-fix.log`).
- Logs: `/private/tmp/fez-parallel-evals-quiet.log`, `/private/tmp/fez-parallel-rust-tests-final.log`, `/private/tmp/fez-parallel-native-final.log`, `/private/tmp/fez-parallel-signed-build.log`.

## Browser Use rename

- Package and checkout are now `@fezchat/browser-use` / `packages/fez-browser-use`; the only advertised MCP tool is `browser_use`.
- Bundled packages, native eligibility, current documentation and test consumers use the new name. The native host also recognizes existing `computer-use` attachments, and the MCP entrypoint accepts the old lab session environment variable as a fallback.
- Legacy prototype install IDs and historical test logs keep their original names. Browser Use controls browser panes; full desktop Computer Use remains unimplemented.
- Rename verification: root, desktop and Browser Use typechecks pass; **2,493 evals pass, 11 optional tests skipped** (`/private/tmp/fez-browser-use-rename-evals-local.log`). Native Rust: **131 pass, 1 ignored**, including current/legacy attachment eligibility (`/private/tmp/fez-browser-use-rename-native.log`). Both session environment names are verified against packed MCP entrypoints. The initial sandboxed gate was stopped after local socket access was denied; the successful run used local socket access.
- Local registration and Fez/Quill/Drift persona attachments migrated to `browser-use` using the shared attachment helpers; other tools and settings preserved. Private backup: `/private/tmp/fez-browser-use-rename-backup-0fIdg9`. The configured local command was launched and tool discovery returned only `browser_use`.
- Normal signed build with the renamed bundled package retained at `packages/fez-desktop/src-tauri/target/native-browser/verified-browser-use/fez.app`; deep/strict signature verification passes. Build log: `/private/tmp/fez-browser-use-rename-build.log`. Not notarized or published. **Use this artifact for the next launch after the pending Keychain approval**, rather than `verified-startup-fix/fez.app`, whose older host only recognizes the old attachment name. The older app was left running for its pending user dialog; no new UI launch or live action was attempted.

- Owner approved the earlier Keychain dialogs at 18:54 on September 13; securityd confirms those actions. Quit the old signed app through its native quit dialog and launched `verified-browser-use/fez.app` (PID 28752). A fresh Chromium Safe Storage prompt appeared for this copy at 18:55:20. UI remains blank while it waits. The existing ACL still names the early `cefsimple.app`; no ACL or secret was modified. A new user-input request identifies this rebuilt copy explicitly.

### Approved launch: remaining native rendering failure

- Owner approved the current copy at 19:01:08 and 19:01:10; securityd confirms no subsequent prompt for PID 28752. Keychain is no longer the current blocker.
- The full Fez chat interface loaded and appeared in accessibility. Both CSP blob-script errors recovered through the existing IIFE fallback (`fez-browser` and `browser-cef-prototype` loaded). Do not loosen CSP to address these warnings.
- Owner confirmed the main window is white on their screen too. Raising/resizing did not restore painting. Native stack capture showed an idle AppKit event loop, not a Keychain wait or main-thread deadlock (`/private/tmp/fez-approved-startup.sample.txt`).
- Local DevTools console became usable after explicitly raising its native window. Read-only inspection found `readyState: complete`, normal CSS visibility/opacity, a 2560×1378 CSS viewport and matching 5120×2756 native bounds. The parent window reported visible, while the document reported hidden. Root cause remains unconfirmed; this is native visibility/lifecycle evidence, not proof of a CSS or frontend startup bug.
- A diagnostic `webview.show()` was refused by the existing ACL; no permissions were changed. A confirmed `location.reload()` cleared the console, but the main renderer then disappeared from accessibility and its DevTools shortcut stopped responding. Normal Cmd+Q could not display the frontend quit dialog.
- Restart of the exact same signed artifact is the next controlled check. PID/path was verified, but automatic approval review rejected `kill -TERM 28752` because termination bypasses quit safeguards and may interrupt local work. No signal was sent; explicit owner approval is pending. No source changes, rebuild, publication or fresh test claims were made during this investigation.

### Approved restart and render diagnostic follow-up

- The owner explicitly approved termination/restart, resolving the earlier approval block. The stalled process and subsequent controlled diagnostic copies were restarted; Keychain approvals were completed by the owner. Current diagnostic copy: `/private/tmp/fez-render-diagnostic3.app`, title `Fez · Render Diagnostic`.
- The owner confirms **chat is visible in that specific window**. Chromium's own raster capture also shows the complete interface. Sky window captures alternate between a rendered inactive window and white content when focused; the owner is being asked whether focus changes physical visibility too. Do not infer physical blankness from these captures alone.
- Native inspection found the correct NSWindow/parent, normal bounds, visible ancestors and opaque layers. Both the normal host and the prior lab are outside an inherited OS sandbox. Deep/strict signature checks pass outside the tool sandbox; production still requires CEF sandboxing and System secret storage.
- Diagnostic3 temporarily disables layer backing on the Winit parent after startup. This is **only in disposable staged source**, has not been shown to cause the user's visible recovery, and is not a production fix. The shared temporary Cargo release binary currently contains diagnostics; do not package it as the clean artifact.
- A local `/browser https://example.org/` command opened a native pane (reported address `https://example.com/`, so initial navigation still needs verification). The New browser UI creates additional panes, but automation focus/targeting is inconsistent. Live independent navigation, closing the intended pane and clean production-artifact visibility remain unverified. No external chat messages were sent.
- Clean signed artifact remains `packages/fez-desktop/src-tauri/target/native-browser/verified-browser-use/fez.app`. No production source change, npm publication, notarization or new full-suite claim was made during this diagnostic follow-up.

### Clean artifact verification after owner confirmation

- Owner confirmed the diagnostic window works when clicked. Quit that copy through Fez's normal quit confirmation and reopened the **unmodified** signed `verified-browser-use/fez.app`; signature verification passes. Main binary SHA-256: `b6dd1916f4aeab7639e1de0cb715a20b9cd8e6343fa8a9a5996147117b965b12`.
- The clean app renders chat and native browser panes correctly in both accessibility and window screenshots. No diagnostic parent-layer change is needed. Side-by-side panes are visibly confirmed; navigating Browser 2 to `https://example.org/` leaves Browser 1 at `https://example.com/`, and closing Browser 1 preserves Browser 2 and its address.
- A distinct issue remains: `/browser <address>` opens the default page despite its address argument (reproduced with both Enter and the submit button, and two different addresses). Manual navigation succeeds. A native regression is being added to check immediate navigation after mount, including a slow-loading page. Its first run passed initial navigation but later exposed the older lab binary's lack of the Browser Use rename; current lab source is being rebuilt before further conclusions.
- Local DevTools was closed after inspection; no remote debug port was added to the real profile. No production workaround has been applied, and no publication occurred.

- Immediate native navigation succeeds against both immediate and 1.5-second-delayed fixture responses. The temporary native diagnostic assertions were removed after that hypothesis was rejected. The current lab was rebuilt from `/var/folders/xw/b0sklf9s1xq8_63v0t0xk2gh0000gn/T/fez-tauri-cef-RY49Gp`; the unchanged complete native regression passes in 9.56s (`/private/tmp/fez-current-native-clean.log`). An earlier run with the live app active was interrupted by a control change; do not treat that run as passing.
- To identify whether the supplied URL reaches the installed extension, its local GUI bundle has a **temporary visible trace** only: `/Users/ken/.fez/packages/fez-browser/dist/gui.js`. Exact original backup: `/private/tmp/fez-browser-initial-url-original.js`. Restore this file before finishing or packaging. Production repository code and signed app binary are unchanged.
- After local DevTools closed, normal quit stopped responding again. The exact signed-app process (PID 43472) was terminated under the owner's earlier restart authorization. Reopened PID 47227 is waiting for a fresh `Chromium Safe Storage` prompt, confirmed by securityd at 19:55:03. Owner input is pending; do not automate the protected system prompt or alter Keychain ACLs. The trace check has not yet run. Also rule out automation updating the visible composer without preserving the complete React draft before attributing the missing URL to native code.

### Diagnostic cleanup and remaining release work

- Removed the temporary URL trace and restored `/Users/ken/.fez/packages/fez-browser/dist/gui.js` byte-for-byte from its saved original. Restored SHA-256: `4dc63ce0df4452397f2cff2e8122121c9fd6dec3737feb07775678e8ca62da5d`. No production rendering workaround was added.
- The requested feature implementation and clean signed-app layout/isolation checks are complete. `/browser <address>` still needs a manual-input check to distinguish an application issue from automation input behavior. The discarded native-startup theory did not reproduce it.
- Release is not complete: changes remain uncommitted on `codex/cef-browser-prototype`; Browser Use is still a development preview (`0.0.0`, stale minimum-host metadata, checkout-oriented README). Prepare matching host/package release metadata and review before publication. Notarization/updater credentials remain unavailable. No npm package, app release, commit or push was performed as part of this follow-up.

### Starting URL and 0.4.40 release preparation

- Confirmed through ordinary pasted slash commands: the URL reached the extension and `navigate()` resolved, but the browser remained at Example Domain. Navigating to the same IANA URL through the address bar worked.
- The pinned Tauri CEF runtime creates an internal placeholder and posts its initial navigation after initialization-script registration (`webview.rs`, `load_initial_url_after_registering_initialization_scripts`). Fez's immediate second navigation could be overwritten by that deferred default load. The host now accepts the starting URL when creating the surface, with the same HTTP(S)/credential validation as later navigation; the GUI no longer performs two startup navigations.
- Two focused regressions failed before the fix; all 16 focused GUI tests pass afterward. Native coverage checks requested-page startup, absence of a default-page visit, and rejection of file/credential URLs. The initial assertions were corrected to allow the runtime's asynchronous internal placeholder. Subsequent native input checks are being traced after intermittent control-change failures; do not count these runs as full native passes.
- Prepared desktop 0.4.40 and Browser Use 0.1.0 metadata, public install instructions, the extension gallery entry, and the publish-batch entry. `minFezVersion` is the separate extension-host contract (0.2.2), not desktop 0.4.40.
- Current complete eval gate: **2,493 passed, 11 skipped** (`/private/tmp/fez-browser-release-evals.log`). Root/desktop/Browser/Browser Use checks and the frontend build pass. Native Rust gate: **131 passed, 1 ignored** (`/private/tmp/fez-browser-release-rust.log`).
- Clean Developer ID-signed 0.4.40 app retained at `packages/fez-desktop/src-tauri/target/native-browser/verified-0.4.40/fez.app`; deep/strict signature verification passes. No notarization or updater artifacts: the required credentials remain unavailable. The actual public app release is in `KennethAshley/fez-releases`, currently 0.4.39. npm currently has Browser 0.1.0 and no Browser Use package; npm authentication is available.
- Installed Browser GUI updated to the tested build after checking the original file hash, preserving local configuration. Temporary UI tracing is removed. The old full-profile app ignored both normal quit and SIGTERM; its exact verified PID was force-stopped under the owner's prior restart approval. The new signed app has not yet been launched.

### Final verification after owner visibility confirmation

- Owner confirmed they were switching applications during the native checks and agreed to leave the lab visible. The hidden-document trace explains the earlier intentional control revocations; no production visibility or takeover guard was weakened.
- The clean native regression now passes in **10.78 seconds** (`/private/tmp/fez-browser-native-verified.log`), including the starting-URL regression, parallel driver/cursor input, exact waiter cancellation, and owner takeover/teardown. The test explicitly focuses its own lab window at startup and after testing minimize/restore. That permission exists only in lab staging. All temporary native and DOM traces were removed from the tested source.
- Final focused packaging/API/GUI checks: **22 passed** (`/private/tmp/fez-browser-release-final-focused.log`). Final root and desktop typechecks pass. Public tarballs for Browser 0.1.1 and Browser Use 0.1.0 pass `npm publish --dry-run`; retained in `/private/tmp/fez-browser-release-44ouv3hz/`. No npm publication occurred.
- The clean signed 0.4.40 app starts with the normal chat interface. The ordinary `/browser https://www.iana.org/domains/reserved` command opens the actual IANA-managed Reserved Domains page, verified in the settled native window screenshot. No address-bar retry was needed. The fixed app is left open for the owner.
