# Shared browser and computer use

**Current naming:** Browser Use (`@fezchat/browser-use`, MCP tool `browser_use`). Earlier Computer use names below record the original implementation and test history. Full desktop Computer Use remains separate future work.

User-approved direction: retain Tauri, give Fez a browser people can use directly,
and offer computer use as a separate extension that can operate that browser and
eventually other explicitly granted surfaces.

## Ownership

- The desktop host owns native view lifetime, bounds, visibility, and input
  ownership. Extensions cannot authorize themselves or bypass owner takeover.
- The browser extension owns browser UI and browser-specific behavior. It remains
  useful without an agent or the computer-use extension installed.
- The computer-use extension exposes observation, clicks, typing, keys and scrolling
  to an attached agent. It acts only on a surface granted by the owner. It does not
  install a browser or assume that its target is the entire physical desktop.
- A browser runtime may be separately installed, but native hosting must exist in
  the app. Optional runtime signing, helper placement and loading need validation;
  the current probe does not establish production packaging.

## First integration

Reuse the existing CEF prototype control bridge. Extract its MCP computer-use tool
into its own package and pass a private session descriptor containing only the
agent capability, target identity and local control endpoint. Do not share the
owner capability with the agent extension. Do not introduce a provider registry
until a second real surface needs it.

The host retains the authoritative grant. Takeover, target replacement, resize and
shutdown invalidate observations and prevent further agent actions. Browser page
content is untrusted and cannot request a broader grant. Session discovery must
not choose an unrelated browser or application when a target disappears.

## Native rendering gate

Before making the embedded browser the default, an isolated Tauri test must load
an HTTP page, render it in a child view, accept input, and shut down cleanly. The
test must not start the user's Fez identity, relay or agents. Then verify pane
bounds/visibility and owner takeover against the native view. The existing image
preview remains a development fallback until those checks pass.

Current state at the start of this work: the separate-process CEF control test
passes; native offline HTML renders, but native HTTP navigation stalls. Raw CDP
is reachable by trusted local processes in this probe; production needs a private
transport and complete popup, download, accessibility and lifecycle coverage.

The extension split now passes real MCP browser input and takeover checks. Native
HTTP loading and capture pass in the isolated test with CEF's mock Keychain:
the earlier stall was a Chromium Keychain wait, not a missing browser API.
Signed-app Keychain setup, native input ownership and clean browser-only shutdown
remain gates before replacing the current preview.

## Upstream Tauri browser candidate — September 13

Tauri's `feat/cef` branch already provides `tauri-runtime-cef`, child webviews,
native DevTools messaging, sandbox/secret-storage configuration and CEF-aware
bundling. Prefer evaluating that host implementation before extending our custom
`native.rs`. This is experimental upstream work, not a dependency change already
made to Fez. Tauri's ordinary macOS webview remains WKWebView; it does not expose
our Chromium control API without a different backend.

Built and tested the [upstream example](https://github.com/tauri-apps/tauri/tree/c8c75b1f7f43e7cb1e7d773ed2f6f96fad2fe975/examples/cef)
at commit `c8c75b1f7f43e7cb1e7d773ed2f6f96fad2fe975`, entirely outside Fez:

- Its own CLI built and bundled the app, framework and helper successfully.
- In-process `send_dev_tools_message` clicked an input, typed text, clicked Save,
  verified the resulting output and captured a PNG.
- Two native child webviews reported the same parent window and separate 450×520
  bounds. A child loaded an ordinary local HTTP fixture successfully.
- `Browser.close` closed the example and the process exited with code 0. This does
  not yet establish closing only the browser pane while Fez stays open.

The sample needed Alloy mode for macOS native child views; explicitly requesting
Chrome mode failed to create them. Other test-only changes supplied a disposable
profile and enabled a random local debugging port to bootstrap the regression
driver. Tested with required sandboxing and mock secret storage; signed release
Keychain behavior remains untested. The control assertions exercised the native
message API, but the external test driver also used its temporary debug port.

Temporary checkout: `/private/tmp/fez-tauri-cef-upstream`. Driver:
`/private/tmp/fez-upstream-cef-check.mjs`. Evidence:
`/private/tmp/fez-upstream-cef-final-check.log` and
`/private/tmp/fez-upstream-cef-result.json`. These are feasibility artifacts, not
production code. Fez's dependency versions, installed app and running preview
were not changed by this comparison. Adoption still needs compatible Tauri/CLI/
plugin versions, isolated-panel regression checks, pane lifecycle and owner grants.

## Fez integration lab

`packages/fez-browser/prototype-tauri-cef` now stages the real Fez Rust shell with
the pinned runtime and compatible plugins. Production manifests are unchanged.
The lab reuses Fez's app context, command guard, channel interceptor and clipped
bounds, but starts a separate identity-free toolbar rather than the normal app.

The bundled lab passes native click/type/save/capture, address updates, bounds,
hide/show, browser-only close/reopen and owner-toolbar reload. Remote pages fail
Tauri's origin ACL; bundled assets loaded in the child separately fail Fez's exact
label guard. The 14 existing isolated-panel Rust tests pass in packaged-asset mode.
Core typecheck and the full eval gate pass: 2,448 tests, with 11 tests skipped;
the new native test was then run separately against the actual app bundle.

Evidence: `/private/tmp/fez-tauri-cef-final-live.log`,
`/private/tmp/fez-tauri-cef-host-tests3.log`, and
`/private/tmp/fez-tauri-cef-evals.log`. A direct macOS mouse click also navigated the
child from Example Domain to IANA with external debugging disabled. This establishes
the host foundation; the real extension workspace, native takeover, production
Keychain, and CEF-origin settings/details rendering still need integration.

## Verification

Use real MCP transport tests for extension composition, missing/invalid grants,
observed-coordinate input and revocation. Use opt-in native CEF integration tests
for rendering and input. Run core typecheck and the complete Fez eval gate before
claiming an implementation works. Native experiments remain feature-gated and
must not replace Camofox or the installed Fez application during development.

## Shared queue — September 13

The owner approved attachment-based eligibility and one driver per browser. The
native strip now shows the current driver and waiting agents, with Take control,
Resume agents and Stop. The separate persona picker is removed. A live local
runtime carrying Computer use may request the open browser during an admitted
Fez turn; installation without attachment gives no input authority.

The TypeScript runtime writes a private atomic context containing effective tool
names, the current message ID, ordered explicit addressees and running/done state.
The native host reserves those participants together when the first one requests
observation. A local persona still starting has a two-minute reservation; a live
runtime without Computer use is skipped. Only an attached live runtime receives
a persona token, and only the current driver may use input. Context expiry,
completion and process exit relinquish control. A new driver gets a new epoch
and must obtain its own screenshot.

Take control pauses the whole queue. Waiting observation calls poll without
performing input and respect MCP cancellation; only owner Resume agents resumes
acquisition. Every native input dispatch still checks the epoch and visibility.
Parallel browsers remain deferred.

An unconditional `then @agent` is an explicit instruction in the shared addressing
parser. Agents already addressed by a request do not need a second assignment in
another agent's reply: those peer references are published without the summon
marker, while new and conditional handoffs retain their normal addressing.
