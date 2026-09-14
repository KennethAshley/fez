# Throwaway CEF browser probe

Branch: `codex/cef-browser-prototype`. Do not publish this package or replace Camofox yet.

This probes whether real Chromium can be shared between a human-facing Fez side pane and an MCP browser-use tool. It uses the existing `openPanel`/slash-command extension seams, with an optional generic `workspace` layout hint for a wide, resizable split. No new npm dependencies.

## What this establishes

CEF 152 on Apple Silicon exposes usable CDP screenshot, typing, keyboard and navigation commands. The runnable `smoke.mjs` check uses a real CEF page and the real MCP transport: it types and saves text, checks the rendered result, rejects an agent before handoff and after takeover, and verifies Stop removes the temporary profile.

The pane uses JPEG polling, not native NSView embedding. The separate CEF window must currently remain available: hiding the upstream sample window caused screenshot capture to time out. Background-throttling switches keep captures working when Fez covers that window. This is a feasibility result, not a production browser implementation.

September 13 visual check: the pane opened alongside a real Fez channel. Clicking the image and typing with the keyboard saved “human” in the Chromium fixture. The pane's Give agent control button authorized an MCP client to navigate and save “agent handoff verified” in that same browser. Take control then rejected subsequent MCP input. This used the tool transport, not an autonomous model turn. The GUI bundle must use Fez's `__fezExt` IIFE fallback; the ES-module-only bundle did not load in this WKWebView.

## Build CEF once

Prerequisites: Rust, Apple command-line tools, CMake and Ninja. Tested with `tauri-apps/cef-rs` commit `207bdd2917c038283635022ffcf7767496bcc7e6`.

```sh
git clone https://github.com/tauri-apps/cef-rs.git /private/tmp/fez-cef-probe
git -C /private/tmp/fez-cef-probe checkout 207bdd2917c038283635022ffcf7767496bcc7e6
cd /private/tmp/fez-cef-probe
cargo run --bin bundle-cef-app -- cefsimple -o target/bundle
```

The upstream sample bundles a menu using `ibtool` (full Xcode). On this machine compilation succeeded and the complete executable/framework/helper bundle was present before that optional menu step failed. The resulting app ran and passed the control test without the menu. For a clean menu-free build, remove `resources_path = "resources"` from the sample's `examples/cefsimple/Cargo.toml` before running the bundler.

## Start from the Fez checkout

```sh
FEZ_CEF_EXECUTABLE=/private/tmp/fez-cef-probe/target/bundle/cefsimple.app/Contents/MacOS/cefsimple \
  node packages/fez-browser/prototype-cef/start.mjs
```

This starts the browser, generates a session-specific GUI bundle, and links the development extension. Restart Fez when no work is running, then enter `/cef` in a chat. The pane has back/forward/reload, an address bar, a control toggle, and Stop. Click the browser image before typing; Escape exits its keyboard capture, and Cmd/Ctrl+L focuses the address bar. Rebuild/relink with the command above after restarting the browser because session capabilities rotate.

On the updated desktop host, the browser takes a wide split beside chat. Drag the divider (or focus it and use arrow keys) to resize. The Chromium viewport follows the pane, so text stays at normal scale. Resizing returns control to the human and waits for a fresh frame before accepting input. Take control and Stop remain available if screenshot capture fails. Older desktop hosts can load the toolbar but ignore the width hint.

September 13 layout verification: the updated desktop build displayed the live Bazaar beside chat, with working divider resizing, wheel scrolling, and Back. Direct mouse input saved the local form in the larger viewport. A new live Claude run at the resized dimensions clicked Draft at (128,135), saved `Fez live agent verified` with a click at (199,135), and stopped after takeover. GUI regressions cover fitted-image coordinates, capture failures, and stale frames during queued resizing; the native check also covers viewport dimensions, scrolling, history, and reload.

The browser GUI and agent tool now link as separate development extensions.
The MCP server is `computer-use-prototype`; its tool is `browser_use`, implemented
in `packages/fez-browser-use`. No existing agent is automatically given it.
The owner grants the same browser through a private `agent-session.json` descriptor
that excludes the owner token. Previously linked `browser-cef-prototype` MCP
definitions continue through a compatibility shim. Both paths use one implementation.
Testing is limited to the disposable fixture, including the live-model check below.

### Live-model check (September 13)

The subsequent real Claude ACP session used Fez's `openSession` harness with only this test MCP server configured, a temporary working directory, and no existing persona changes. It saved `Fez live agent verified` using Tab/type/Enter after pointer attempts failed. During the next task, the test controller revoked control after the first completed tool call. The next browser tool failed, the model stopped, and the saved output remained unchanged. The session closed and browser ownership returned to human.

The initial click-only follow-up failed: screenshots were 2400×2558 while the CSS input viewport was 1200×1279. Mapping Retina pixels alone was insufficient because the model can also resize oversized images. A subsequent diagnostic recorded the actual DOM mouse events: the old model coordinates hit the page background, while exact screenshot coordinates focused the input and saved successfully even with the CEF window in the background.

The corrected broker now uses Chromium's native screenshot scaling to cap agent images at 1024 pixels per edge; human previews retain full resolution. MCP returns the actual image dimensions and maps each coordinate axis back to CSS pixels. On the same viewport the agent image is 961×1024. A fresh Claude pointer-only run clicked Draft at (142,149), typed `Fez live agent verified`, clicked Save at (219,149), and verified the saved output without Tab/Enter fallback. Mid-task takeover then rejected its next action and preserved the result. This validates the local form, not general browsing: signed-in sites and a standing Nostr channel agent remain untested. Do not replace Camofox based on this probe.

Run explicitly (uses the configured Claude account and makes real model calls):

```sh
node packages/fez-browser/prototype-cef/live-agent.mjs
FEZ_CEF_POINTER_ONLY=1 node packages/fez-browser/prototype-cef/live-agent.mjs
```

Each run writes ignored `live-agent-result.json`, asserts the actual saved page output, and returns control to the human in cleanup. The second command requires screenshot-coordinate clicks to focus and save.

The native regression in `packages/fez-evals/tests/cef-pointer.test.ts` starts an isolated broker/profile, checks image dimensions and pointer mapping against real element bounds, and verifies takeover. It skips when `FEZ_CEF_EXECUTABLE` is unset. Run from `packages/fez-evals`:

```sh
FEZ_CEF_EXECUTABLE=/private/tmp/fez-cef-probe/target/bundle/cefsimple.app/Contents/MacOS/cefsimple \
  npx vitest --run tests/cef-pointer.test.ts
```

Run the check against a fresh session (it closes that session):

```sh
node packages/fez-browser/prototype-cef/smoke.mjs
```

## Boundaries and remaining work

- Fresh temporary profile; no cookie import, saved credentials or Fez identity access. Stop closes CEF and deletes that profile. SIGINT/SIGTERM clean up; a machine crash or SIGKILL can leave temporary data.
- Random bearer capabilities gate the loopback control service. Agent requests cannot grant themselves control. The raw CEF debugging port is also loopback but has no authentication: this prototype assumes trusted local processes and is not an OS security boundary.
- The screenshot view supports wheel scrolling and plain-text paste, but does not expose a full accessible page tree, browser context menus, downloads, popups, copy/selection, or complete keyboard shortcuts. Do not ship it as a general-purpose browser.
- Production needs native embedding or an offscreen renderer, reliable revocation when the host dies, agent-specific grants, frame/input synchronization, browser update/signing packaging, and complete input/accessibility coverage. The 1024px agent image trades detail for a stable coordinate system; tiny targets will need cropped views or structured element access.

Generated `session.json`, `agent-session.json` and `gui.js` contain local capabilities
and are gitignored, as is the generated `computer-use/` development package.
Never upload them. Camofox source and configuration are unchanged.

### Native embedding experiment (unfinished)

The optional desktop Cargo feature `cef-prototype` compiles `native.rs` from this
extension into the Tauri shell. It registers CEF's macOS application protocols,
loads Chromium from the Fez app bundle, and attaches an NSView child to the main
Fez window. It does not replace the working JPEG workspace above.

Local probe results, 2026-09-13:
- An offline HTML page renders inside the existing Fez window; no separate CEF
  top-level window is created. The temporary view uses fixed 600×600 bounds.
- The original HTTP stall was a Chromium worker waiting on macOS Keychain.
  The isolated regression now loads the HTTP fixture and captures its rendered
  page using upstream CEF's test-only `--use-mock-keychain` flag. Removing the
  persistent cache setting did not resolve the wait. Real signed-app Keychain
  setup remains unverified; the test flag is not a release storage policy.
- Pumping CEF from `AppHandle::run_on_main_thread` deadlocked by re-entering Tao's
  event-handler mutex. A native NSTimer avoids that deadlock.
- This probe loaded sandboxed helpers successfully only after copying Chromium's
  framework/helpers into the host app's `Contents/Frameworks`. Referring to the
  separate sample bundle caused load errors. Optional runtime distribution is a
  separate packaging question; this result does not rule it out.
- Native handoff is disabled: native input ownership, pane bounds/lifecycle,
  popup handling, and clean browser-only shutdown are not yet connected.

To reproduce on the development checkout, start `start.mjs` with
`FEZ_CEF_NATIVE=1` and the existing `FEZ_CEF_EXECUTABLE`. Build the desktop with
`--features cef-prototype`, copy the sample bundle's `Contents/Frameworks` into
the debug Fez app's `Contents`, then launch that debug app. The broker writes a
private, ignored `native-bootstrap.json`; do not use this mode for normal browsing.
The regular build (without the feature) and regular `start.mjs` remain the usable
preview. No native experiment has been shipped.

`native-probe.rs` is an identity-free Tauri test app using the same `native.rs`.
It creates only a blank host window and the CEF child: no Fez identity, extensions,
local relay or agents. Build with `cargo build --example cef-native-probe --features
cef-prototype` in `packages/fez-desktop/src-tauri` (using the existing `CEF_PATH`).
Put the example executable in a separate `.app/Contents/MacOS`, with the sample's
`Contents/Frameworks` and an Info.plist naming `cef-native-probe` as its executable.
Ad-hoc sign that disposable app with `codesign --force --sign - /path/to/Probe.app`.
When rebuilding, replace its executable atomically and sign again; overwriting a
previously signed executable in place caused macOS to kill it before startup.
Then run from the repository root:

```sh
FEZ_CEF_NATIVE_PROBE='/path/to/Probe.app/Contents/MacOS/cef-native-probe' \
  npm test --prefix packages/fez-evals -- tests/cef-native.test.ts
```

This regression verifies the `Native HTTP works` title and a PNG capture. It
uses a disposable profile and mock Keychain, never the user's browser credentials.
On failure it reports the page state, fixture request count and current CEF log
before cleaning up. Waiting explicitly for `on_context_initialized` and adding
immediate scheduled-work callbacks did not resolve the original stall; both
speculative changes were removed. Tauri also has an experimental `feat/cef` runtime with a complete
external pump (`crates/tauri-runtime-cef/src/external_message_pump`), which is a
reference for further comparison rather than a dependency adopted by this probe.
The ordinary eval gate skips this opt-in test. Neither the ordinary suite nor
this rendering check establishes native takeover, lifecycle or release readiness.
