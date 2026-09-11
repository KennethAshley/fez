# Isolated GUI Panel Implementation Plan

> Execute inline using superpowers:executing-plans; use a separate reviewer
> after the native boundary and panel integration are complete.

**Goal:** Run ElevenLabs voice settings in an unprivileged local webview and
prove its allowed preference write and denied native access.

**Architecture:** Rust owns webview identity and a closed preference broker.
The main loader registers a launcher; a separate bundled entry evaluates and
mounts the extension. Existing general native commands are confined to main.

**Tech stack:** Tauri 2, React 19, TypeScript, Rust, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-isolated-panel-design.md`

## Constraints

- Opt-in with `VITE_FEZ_ISOLATED_PANEL=elevenlabs`; no main-page fallback.
- No subprocess, identity-export or arbitrary-file capability in the pilot.
- CSP blocks fetch/media; the native probe found WebRTC traffic is still possible.
  Full network isolation is outside this native-privilege pilot.
- Preserve the shared working tree and unrelated changes; no blanket staging.
- Test with temporary state and never access the real keychain.

## 1. Native caller guard and preference broker

- [x] Add failing native IPC tests: a non-main caller's general command is
  rejected before dispatch; a bound panel can set its own preference; an
  unknown view, extra `extension` field, revoked grant and malformed data fail.
- [x] Implement `isolated_panel::guard` around the existing invoke handler and
  `PanelHost` with a native-owned session map and fixed home directory.
- [x] Add the closed `PanelRequest` enum and `isolated_panel_request` command.
  Bind namespace to the injected caller and load current recorded grants.
- [x] Share preference read/write helpers with the existing native commands;
  check file read/parse failures before writing and preserve unrelated keys.
- [x] Run the native IPC tests, including the production main capability file.

## 2. Local window and real panel

- [x] Add failing loader/browser tests: host-side activation must not occur;
  the real ElevenLabs voice selection saves through the broker and denial is visible.
- [x] Implement native `open_isolated_panel`, a fixed entry URL, isolated
  browser store, CSP and navigation/popup restrictions; remove session on close.
- [x] Add `isolated-panel.html` and its React entry, using the current
  mount/dispose contract inside the isolated document.
- [x] Add the opt-in loader branch and launcher; pass only a public agent
  snapshot. Preserve existing loading for unselected extensions.
- [x] Make the ElevenLabs panel surface preference/preview failures.
- [x] Run the real panel browser tests and build/typecheck the desktop.

## 3. Verify and document the actual result

- [x] Attempt a native WKWebView smoke probe without the user's keychain or
  agent startup; record any environment limits explicitly.
- [x] Review the caller guard, namespace binding, loader bypass, and failures.
- [x] Run root typecheck and the Fez eval gate; distinguish pre-existing relay
  test contention from failures introduced by this pilot.
- [x] Document how to run the pilot, supported operations, and remaining scope.

## Verification result — 2026-09-10

- Root and desktop TypeScript checks passed; ElevenLabs and desktop builds passed.
- Focused evals: 24 passed, including native IPC, GUI grants, storage and API mirrors.
- Browser: two cases passed against both production preview and the dev server;
  the actual voice panel saves, displays denied saves/preview failures, and disposes mounts.
- Real WKWebView: passed using both local preview and bundled `tauri://` assets.
  The main webview opens the panel through IPC; prefs save; native/plugin calls,
  namespace spoofing, navigation and popups are rejected; main globals/storage
  are absent. A `connect-src` violation confirms fetch blocking.
- WebRTC loopback traffic was observed in both native runs. The documented scope
  is native privilege isolation, explicitly not a complete network sandbox.
- Review findings closed: private 0600 state files remain private after atomic save;
  network claims narrowed to match the measured behavior.
- Full eval gate remains unclean in the shared working tree. One full run reached
  1,638 passes with only the known relay-watch timing failure. A subsequent run
  with four workers reached 1,617 passes and failed unrelated mining/Ridges tests
  amid concurrent edits, plus multi-relay setup on occupied ports 7801–7803.
  Focused pilot checks passed again afterward. No unrelated changes were reverted.


## GitHub settings migration

Architectural follow-up authorized by the user's “continue”. Reuse FezClient's encrypted app-data implementation and Octokit's device-flow implementation.

- [x] Native broker: closed config, write-only secret, HTTPS request and browser-link operations; current grants and actual webview identity remain authoritative.
- [x] Bind a Tauri channel from the main launcher to its FezClient. Native forwards only authorized, scoped host operations; replies require main, expire after 30 seconds, and are discarded on close/revocation. Config and secrets use the existing fez-prefixed namespace; linked aliases are supported only with one installed owner.
- [x] Publish the exact implemented API; inject broker fetch into Octokit. Keep settings-source navigation through declarative fez.settingsSource manifest metadata.
- [x] Exercise GitHub connect, saved config, watch, triage, links and denied operations with simulated GitHub/keychain boundaries. Verify native routing/denial and the real isolated webview.
- [x] Review, typecheck, build, run focused and full eval gates; document opt-in setup and verified limits.

HTTPS broker: exact recorded `network:<hostname>` grants only; HTTPS port 443, no URL credentials, no automatic redirects, bounded bodies/responses/time, reject non-public resolved IPs and privileged request headers. Browser links use the same URL/grant check. No native secret-read operation. Existing CSP/WebRTC limitation remains: this is a native authority boundary, not a complete network sandbox.

The GitHub browser flow passes with simulated services; native routing and
large JSON/binary delivery pass in the actual bundled macOS window. A native
regression first reproduced cross-webview reads of Tauri's large channel
queue; the channel interceptor now prevents queue insertion while retaining
delivery. Root/desktop/GitHub/extension API/ElevenLabs checks pass. Final full
eval results are recorded below once the gate finishes.

Final GitHub migration verification (2026-09-10):

- Full eval gate: **1,670 passed, 5 skipped** across 184 files; no failures.
- Browser runner: **4 passed** (ElevenLabs, mount cleanup, GitHub connect/watch/triage, keychain/network denials). GitHub services and keychain were simulated.
- Native: **7 isolated-panel IPC/security tests and 5 identity/keychain tests passed**; bundled WKWebView probe **PASS**, including large JSON/raw channel delivery and scoped config/secret round trips. No user keychain access.
- Root and desktop typechecks; GitHub, ElevenLabs and extension API builds/checks; desktop production build passed. Read-only review found no remaining blockers.
- Isolation is still opt-in and macOS-only. WebRTC traffic remains possible, and already-dispatched operations can finish after revocation/close.

Logs: `/private/tmp/fez-github-isolated-evals-final.log`,
`/private/tmp/fez-github-isolated-browser.log`,
`/private/tmp/fez-github-isolated-native-final.log`.

## Manifest-selected settings runtime

Follow-up explicitly selected by the user after the live GitHub test.

- [x] Reproduce missing native metadata and main-window evaluation without the development selector.
- [x] Add `fez.guiRuntime: "isolated-settings"` to the public manifest contract and the two migrated packages. Preserve unknown/invalid declarations so the loader refuses them; absence keeps the legacy host.
- [x] Remove the development selector, preserving existing native session/grant checks and settings-source navigation.
- [x] Verify native metadata, GUI loading, API conformance, browser flows and the full eval gate; relink GitHub and run the updated desktop without the old flag.

The live test also exposed missing background startup. The existing CLI
sentinel now has an explicit entry point and extension selection; its macOS
login-service installer preserves the selection. A GitHub-only login service
was installed and its automatic restart was verified. It does not reintroduce
sentinel ownership into the desktop or sandbox headless extensions.

Manifest runtime verification: **1,686 tests passed, 6 skipped**; 19 native
package tests and four browser cases passed. The actual bundled WKWebView
probe passed. Root/desktop/GitHub/ElevenLabs checks and the extension API and
desktop builds passed; review found no remaining issues. GitHub was relinked
with the declaration, and the desktop was relaunched without the old selector.
Logs: `/private/tmp/fez-manifest-runtime-evals-final.log`,
`/private/tmp/fez-manifest-runtime-browser.log`,
`/private/tmp/fez-manifest-runtime-native-probe.log`.
