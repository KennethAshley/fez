# @fezchat/desktop

fez with a face. Everything the terminal does, plus the surfaces it cannot draw: the lane board where agents' branches become a mission board, live panes to watch a mind work, rich docs, drag-and-drop media, and installable views. Same key, same relay, same workspace as `fez` in the shell — a different body for it.

## Local work and quitting

The desktop owns local agents and permitted background integrations. It restores enabled agents when it starts and keeps them running when you close the window. Choose Quit to stop local work; the confirmation offers **Keep running** or **Quit and stop local work**. The optional headless sentinel is for running without the desktop.

On macOS, check **Always On** in Fez's menu-bar menu to prevent idle system sleep while Fez is running. The display can still sleep. The choice defaults off and is remembered on this Mac; unchecking it or quitting Fez releases the sleep prevention. Closing a laptop lid or explicitly choosing Sleep can still suspend local work. Each extension keeps its own automatic-action controls: GitHub's **triage on** opens a thread for each new issue or pull request and asks `@fez` who should act.

Saving an agent's configuration keeps its current work running. Use **restart** in its profile to apply launch changes; its channels and repository context are retained. Startup failures appear in the app and retry every 30 seconds.

## The GUI extension seam

The desktop hosts `gui` extension parts. At launch it loads `~/.fez/gui-extensions/*.js`, each a module handed a permission-gated API — panels, thread views, message decorators, commands, themes, and a keychain-backed secret store the webview may write but never read. `gui-extensions.ts` is the registry; the mirror-conformance eval keeps every extension honest against it.

## Run

```bash
cd packages/fez-desktop && npm install && npm run tauri dev
```

## Native browser builds

On macOS, the normal build includes the native CEF browser:

```bash
npm run tauri -- build --debug --bundles app
```

The build script fetches the exact Tauri and plugin revisions in
[`scripts/native-browser.json`](scripts/native-browser.json), builds their matching
CLI, and uses [`scripts/native-browser.lock`](scripts/native-browser.lock) with
`--locked`. Rust 1.95+ is required. The first build downloads and compiles the
toolchain; subsequent builds reuse `src-tauri/target`. The app is
`src-tauri/target/debug/bundle/macos/fez.app`. It has the normal `com.fez.desktop`
identity and embeds CEF, its helper apps, Browser control assets, and the bundled
agent runtime. Browser and Browser Use ship as ordinary package archives and
are installed before the GUI starts, using Fez's existing native installer.
Existing packages, links, settings, and later uninstalls are preserved. Bundled
extensions are seeded once; update an installed extension explicitly.
`tauri dev` remains the system-webview frontend development loop.

For an existing checkout, `FEZ_TAURI_CHECKOUT` and `FEZ_TAURI_PLUGINS_CHECKOUT` may
point at those exact revisions. Modified runtime sources or a different revision
fail the build. Do not use the installed stable Tauri CLI to package CEF.

The full app uses the OS secret store for Chromium cookies and saved passwords,
with a cache separate from the disposable lab. Other Chromium web storage is
not encrypted by this setting. The isolated lab still uses mock storage and
should only receive disposable sessions; see the
[`Browser Lab instructions`](../fez-browser/prototype-tauri-cef/README.md).

To build a signed, notarized release without publishing it:

```bash
bash scripts/build-signed.sh
```

This requires the Developer ID signing identity, Apple ID notarization
credentials, and updater signing key in the environment or the `fez-notary`
keychain. `scripts/setup-signing.sh` configures the Apple credentials; provide
the existing updater key as `TAURI_SIGNING_PRIVATE_KEY` or `fez-notary/updater-key`.
Missing credentials
stop before the build. The pinned bundler signs the nested CEF framework and
helpers with Chromium's hardened-runtime entitlements. The script then verifies
the app signature, Gatekeeper assessment, and stapled notarization ticket. Only
`scripts/release.sh` publishes the result. CEF is experimental upstream code;
changing the pins requires refreshing the lock and rerunning native and signed
bundle verification.
