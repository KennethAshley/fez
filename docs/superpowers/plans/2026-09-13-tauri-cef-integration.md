# Tauri CEF integration check

> Execute in this task. Keep the installed app and production dependencies unchanged.

**Goal:** Compile Fez's real Rust shell against the pinned upstream CEF runtime and
exercise a native browser pane through Fez's existing command guard.

**Architecture:** A disposable desktop staging directory uses matching Tauri/CLI/
plugin sources. It compiles the real Fez modules but starts an identity-free browser
workbench. The browser is an unprivileged child webview; only the trusted main view
can navigate, resize, hide or close it. Agent handoff stays disabled until physical
input ownership is enforced. Existing browser and computer-use extensions remain.

1. [x] Add a reproducible staging/build script under
   `packages/fez-browser/prototype-tauri-cef/`; pin upstream sources and reject dirty
   production dependency changes. Compile all Fez Rust modules, including plugins.
2. [x] Add an opt-in eval in `packages/fez-evals/tests/tauri-cef.test.ts` that fails
   without the native workbench. Exercise native input/capture, resize, hide/show,
   browser-only close/reopen, and remote-page denial at the command boundary.
3. [x] Add the minimal workbench host and toolbar using upstream child-view and
   native DevTools APIs. Reuse Fez's `isolated_panel::guard`; do not expose raw CDP
   to remote content. Start only with an explicit disposable profile.
4. [x] Run the native eval, core typecheck and complete Fez eval gate. Record exact
   compatibility changes and remaining release/ownership limits in the README.

Validation commands: staging script `check` then `build`; opt-in test with
`FEZ_TAURI_CEF_PROBE` naming the bundled executable; `npx tsc --noEmit`;
`npm run evals`. No commit, push or installed-app replacement in this milestone.
