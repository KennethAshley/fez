# Isolated GUI settings runner

## Scope

Manifest-selected macOS desktop isolation for compatible installed settings
panels. ElevenLabs and GitHub declare `fez.guiRuntime: "isolated-settings"`.
The development selector has been removed. An absent declaration retains
the legacy GUI host; unknown or malformed declarations fail before evaluation.
This does not sandbox headless/executable parts. Older desktop releases ignore
the new field, so packages relying on it require the updated desktop build.

The main loader registers a launcher without evaluating the selected bundle
or injecting its CSS. Rust opens a separate nonpersistent webview at a fixed
bundled entry; navigation and popups are denied. The runner supports both
legacy React elements and mount/dispose callbacks. It never falls back to
executing a failed panel in main.

## Authority and contract

The actual webview label, supplied by Tauri, selects the native session.
Extension code cannot choose its identity, installed code, state path, or
grants. The closed request enum rejects unknown operations and fields.
Recorded ui grants and installation state are checked on every request.
There is no legacy grant fallback in the isolated broker.

`IsolatedPanelApi` publishes the implemented subset: React, one settings
registration, preferences, write-only secrets, browser links, HTTPS fetch,
and a limited optional client. The client requires read:channels; its agent
snapshot requires read:agents. Config reads require sign and writes also
require publish. Config and secrets use the installed directory prefixed
with fez- when absent. Both github and linked fez-github retain the existing
fez-github namespace; duplicate installed owners are rejected. Preferences
remain strictly directory-scoped.

Rust authorizes host operations and binds a channel to the FezClient captured
by the main-window launcher. The channel carries only an ID. A main-only
command supplies the authorized operation; another main-only command replies.
FezClient still implements encryption, app-data events and relay publication.
Existing native commands still implement keychain set/has and browser opening.
No keychain value is returned by the API. Config/secret inputs are bounded.

Requests are rechecked before dispatch and before returning data. Host requests
expire after 30 seconds; closing a window drops pending replies. Each panel
allows at most 16 requests in flight. Already dispatched work can finish;
revocation/close does not roll back writes or stop an active HTTP request.

All app commands except the broker require main. Plugin capabilities remain
main-only. Tauri 2 exempts its app-wide channel fetch queue from plugin ACL,
so the app intercepts channels and delivers JSON/binary messages directly to
their actual destination webview. This path fails closed. The Windows normal
invoke-response path bypasses the interceptor, so isolation is macOS-only.

## Network and UI

Native HTTPS fetch supports UTF-8 GET/HEAD/POST only. It requires an exact
network:<hostname> grant, port 443, and no URL credentials. It disables proxies,
cookies and redirects, rejects non-public addresses in the resolver used for
the connection, restricts request headers, caps request bodies at 64 KiB and
responses at 2 MiB, and uses a 20-second transport timeout. System DNS lookup
can outlast that timeout. Browser links require the same URL/hostname grant.
Wildcard and relay grants are not expanded by this transport.

GitHub uses this fetch explicitly, including inside Octokit's existing OAuth
device-flow implementation. The panel keeps account connection, repository
discovery, watch/triage toggles and browser links. Denied saves preserve the
visible previous state. Keychain/link errors are visible. The manifest declares
fez.settingsSource=github so the main app can preserve the channel settings
shortcut without evaluating the bundle. Panels without this field remain in
global Settings. Existing recorded grants are not silently expanded.

This is not a complete network sandbox: resource CSP blocks direct fetch,
WebSocket and media loads, but the real WKWebView probe confirms WebRTC/STUN
traffic remains possible. Separate webviews do not guarantee separate OS
processes. Voice previews, process execution, live subscriptions, inline
embedding and full migration of other GUI surfaces remain later work.

## Verification

The eval gate includes actual Tauri IPC caller/namespace/grant checks, linked
name compatibility, duplicate ownership denial, HTTP validation, the shared
channel queue regression, real FezClient config behavior and API conformance.
Browser tests load the actual ElevenLabs/GitHub bundles and exercise device
login, repo/watch/triage changes, permission errors and mount cleanup. External
services and credentials are simulated; no test connects the user's account.

The manual bundled WKWebView probe verifies private browser storage, preference
writes, config and simulated secret routing, large JSON and binary channel
delivery, cross-extension denial, plugin/native denials, CSP, navigation and
popups. It separately reports the known WebRTC limitation.
