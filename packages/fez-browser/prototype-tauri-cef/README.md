# Fez native browser lab

An integration of Fez's Rust shell with Tauri's experimental CEF runtime. The
stager supports the shipping desktop, isolated Browser Lab, and separate Fez Native
development app. Fez Native runs the real desktop, loads the packaged Browser
GUI, and supplies its `nativeSurfaces` provider. Human interaction goes directly
to a native child browser; the Browser Use extension receives screenshots and
input access through a private local socket.

The lab does **not** replace the installed Fez app or Camofox. `@fezchat/browser`
still provides its Camofox agent tools and setup/status/test settings. In Fez
Native it also opens the native pane through `/browser [url]` or **Settings →
extensions → Browser → Open browser**. A stable host without the native
provider reports that it is unavailable while the Camofox tools keep working.
The older [`prototype-cef`](../prototype-cef/README.md) remains a separate lab;
its `browser-cef-prototype` and `computer-use-prototype` IDs are not the current
`browser` and `browser-use` extension IDs.

The host owns a separate control strip. **Give agent control** grants this browser;
**Take control**, typing/clicking/scrolling in the browser, resizing, hiding, and
minimizing revoke the grant. Restoring the window does not restore permission.
**Stop** closes the browser; **Open browser** starts a fresh session. Browsing in
another app does not move its pointer or keyboard focus on behalf of the agent.

## Build the normal desktop

Run `npm run tauri -- build --debug --bundles app` in `packages/fez-desktop`.
The wrapper fetches the pinned upstreams, prepares the frontend and bundled
agent, stages `--release` with the normal `fez` / `com.fez.desktop` identity,
and builds with the committed native dependency lock. For a signed and notarized
release, use `scripts/build-signed.sh`; see the
[desktop build instructions](../../fez-desktop/README.md#native-browser-builds).

## Build the separate Fez Native development app

Requires macOS, Rust 1.95+, Node, and these checked-out upstream revisions:

- [Tauri](https://github.com/tauri-apps/tauri/tree/c8c75b1f7f43e7cb1e7d773ed2f6f96fad2fe975):
  `c8c75b1f7f43e7cb1e7d773ed2f6f96fad2fe975`.
- [Plugins](https://github.com/tauri-apps/plugins-workspace/tree/1423992771e0b57582ca3b06a6adc46ec26aa784):
  `1423992771e0b57582ca3b06a6adc46ec26aa784`.

Build the matching CLI in the Tauri checkout with `cargo build --locked -p tauri-cli`.
Before staging the full desktop, build both the frontend and the bundled local
agent runtime; `stage.mjs --desktop` copies those existing outputs:

```sh
npm run build --prefix packages/fez-desktop
npm run prepare-pi-agent --prefix packages/fez-desktop
npm run prepare-bundled-extensions --prefix packages/fez-desktop
```

The app carries real Browser and Browser Use package archives. Startup seeds
missing packages through the existing native installer; linked/customized
packages and later user uninstalls are preserved. Use `fez link` explicitly
when developing the extension itself from a live checkout.

Then stage the real desktop:

```sh
node packages/fez-browser/prototype-tauri-cef/stage.mjs /path/to/tauri /path/to/plugins-workspace --desktop
```

The command prints a new `/private/tmp/fez-tauri-cef-*` staging directory. From
that directory run the **upstream** CLI (the installed stable CLI cannot bundle it):

```sh
CARGO_TARGET_DIR=/path/to/tauri/target /path/to/tauri/target/debug/cargo-tauri build --debug --bundles app --ci -- --locked
```

Output: `/path/to/tauri/target/debug/bundle/macos/Fez Native.app`. The upstream
bundler supplies CEF 151 and its signed helpers. Do not mix it with the older
custom prototype's CEF 152 framework. Debug only; this is not a release package.

Omit `--desktop` to preserve the identity-free Browser Lab flow documented in
the verification commands below. Its output remains `Fez Browser Lab.app`.

## Run and verify

Start the Browser Lab with `FEZ_UPSTREAM_PROFILE` pointing at a new empty
directory. Only the isolated lab uses mock secret storage; the full desktop uses
the OS secret store and a separate cache. With no debugging-port environment
variable, external remote debugging remains disabled.

```sh
FEZ_UPSTREAM_PROFILE="$(mktemp -d /private/tmp/fez-browser-session-XXXXXX)" \
  '/path/to/tauri/target/debug/bundle/macos/Fez Browser Lab.app/Contents/MacOS/fez-desktop'
```

In Fez Native, open the browser, choose a local persona in the host-owned control
strip, and select **Give agent control**. Installing or attaching Browser Use
does not grant control. Fez writes a descriptor for only that persona at
`~/.fez/native-surfaces/<persona>.json`; takeover, hiding, minimizing, or closing
the browser revokes the grant and removes it. ACP injects `FEZ_AGENT_PERSONA`
into the attached Browser Use MCP server, which resolves that persona-specific
descriptor. The descriptor contains an agent token, no grant API or owner token.

For the identity-free Browser Lab, the host instead writes `session.json` (0600)
beside `control.sock` (0600) in its disposable profile (0700). Pass that exact
descriptor as `FEZ_BROWSER_USE_SESSION` to a separately launched
`fez-browser-use` MCP server. Connecting it alone does not grant access.

The opt-in test creates/removes its own profile and fixture server. Its temporary
debug port bootstraps the trusted UI and reads assertions; all tested agent
input/capture travels through the real MCP server, socket, and in-process CEF API.

```sh
cd packages/fez-evals
FEZ_TAURI_CEF_PROBE='/path/to/tauri/target/debug/bundle/macos/Fez Browser Lab.app/Contents/MacOS/fez-desktop' \
  npx vitest --run tests/tauri-cef.test.ts
```

It checks click/type/save, capture, resizing, minimize/restore, native visibility,
browser-only Stop/reopen, toolbar reload, address updates, and stale-observation
rejection. Both remote content and bundled assets in the browser are denied app
commands. Shared extension JavaScript cannot invoke the owner control command or
raw DevTools; each agent input checks its grant epoch on CEF's UI thread before
dispatch. Page navigation/reload invalidates the observation while retaining the
grant, so the agent must observe the new document.

Run the existing Rust host-boundary tests from the staged `src-tauri` directory
with `cargo test --lib --features tauri/custom-protocol isolated_panel::tests`.
The packaged-asset feature matters: the lab intentionally has no development URL.

## Compatibility changes and remaining gates

All compatibility edits are generated in staging:

- Match Tauri, build tools and plugins; enable CEF's matching macOS private API
  feature. Remove obsolete mobile-only `tauri/wry` references in the pinned plugins.
- Exclude the custom CEF 152 optional dependency; use Alloy native child views.
- Copy compile-time agent metadata locally and expose the existing bounds-clipping
  method to the native host. Reuse Fez's app context, command guard and channel
  interceptor. Lab/development identities disable updates; `--release` preserves
  the normal updater feed, signature key and artifact settings.

The native runtime is pinned experimental upstream code. A passing stage test does
not establish signed-app Keychain behavior or notarization: those require a real
signed build and runtime verification. Popups, downloads, and browser permissions
are currently denied. Native desktop/app computer-use targets remain separate work.
