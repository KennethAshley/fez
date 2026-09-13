# Throwaway CEF browser probe

Branch: `codex/cef-browser-prototype`. Do not publish this package or replace Camofox yet.

This probes whether real Chromium can be shared between a human-facing Fez side pane and an MCP computer-use tool. It uses the existing `openPanel`/slash-command extension seams. No desktop core changes or new npm dependencies.

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

This starts the browser, generates a session-specific GUI bundle, and links the development extension. Restart Fez when no work is running, then enter `/cef` in a chat. The pane has navigation, Take control, Give agent control, and Stop session. Click the browser image before typing; Escape exits its keyboard capture. Rebuild/relink with the command above after restarting the browser because session capabilities rotate.

The MCP server is `browser-cef-prototype`; its tool is `computer_use`. No existing agent is automatically given it. Testing is limited to the disposable fixture, including the live-model check below. The first pass combines the development GUI and tool registration in one private package; production Browser and Computer Use extensions remain a separate integration task.

### Live-model check (September 13)

The subsequent real Claude ACP session used Fez's `openSession` harness with only this test MCP server configured, a temporary working directory, and no existing persona changes. It saved `Fez live agent verified` using Tab/type/Enter after pointer attempts failed. During the next task, the test controller revoked control after the first completed tool call. The next browser tool failed, the model stopped, and the saved output remained unchanged. The session closed and browser ownership returned to human.

The click-only follow-up **failed**: screenshots are 2400×2558 while the CSS input viewport is 1200×1279. An experimental screenshot-to-CSS mapping was added to the MCP adapter, but the model still failed to focus the input or save. This mapping alone does not establish reliable pointer control; model image resizing, targeting, and native focus need diagnosis. Do not replace Camofox based on these results. Signed-in sites and a standing Nostr channel agent were not tested.

Run explicitly (uses the configured Claude account and makes real model calls):

```sh
node packages/fez-browser/prototype-cef/live-agent.mjs
FEZ_CEF_POINTER_ONLY=1 node packages/fez-browser/prototype-cef/live-agent.mjs
```

Each run writes ignored `live-agent-result.json`, asserts the actual saved page output, and returns control to the human in cleanup. The second command preserves the known failing pointer check.

Run the check against a fresh session (it closes that session):

```sh
node packages/fez-browser/prototype-cef/smoke.mjs
```

## Boundaries and remaining work

- Fresh temporary profile; no cookie import, saved credentials or Fez identity access. Stop closes CEF and deletes that profile. SIGINT/SIGTERM clean up; a machine crash or SIGKILL can leave temporary data.
- Random bearer capabilities gate the loopback control service. Agent requests cannot grant themselves control. The raw CEF debugging port is also loopback but has no authentication: this prototype assumes trusted local processes and is not an OS security boundary.
- The screenshot view does not expose a full accessible page tree, browser context menus, downloads, popups, scrolling, clipboard, or complete keyboard shortcuts. Do not ship it as a general-purpose browser.
- Production needs native embedding or an offscreen renderer, reliable revocation when the host dies, agent-specific grants, frame/input synchronization, browser update/signing packaging, and complete input/accessibility coverage.

Generated `session.json` and `gui.js` contain local capabilities and are gitignored. Never upload them. Camofox source and configuration are unchanged.
