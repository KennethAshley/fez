# Browser Use

The `@fezchat/browser-use` extension exposes one `browser_use`
MCP tool: list, observe, click, type, key, and scroll. The Browser extension and Fez
Native supply up to four targets; this package does not install or launch a browser.
The integrated native flow uses the same Unix-socket contract first proven by
the labs in `../fez-browser/prototype-cef` and
`../fez-browser/prototype-tauri-cef`.

## Use in Fez

Requires the native-browser desktop build introduced in Fez **0.4.40**. It bundles
Browser and Browser Use on fresh installs. The package's `minFezVersion` refers to
the extension host API version, which is separate from the desktop app version.

1. Install **Browser** and **Browser Use** from Extensions if they are not already installed.
2. Attach **Browser Use** to your local agents and restart them to load the tool.
3. Open `/browser https://example.org/` in chat.
4. Ask `@fez click Learn more and tell me which page opens`.

For CLI-managed installations:

```sh
fez install @fezchat/browser
fez install @fezchat/browser-use
```

The package does not provide CEF to older desktop builds; update the app to get
native panes. Running agents
with Browser Use attached can list the available browsers and select a target
by its ID or unique label. With several browsers, first call
`browser_use({"type":"list"})`, then
`browser_use({"type":"observe","target":"Browser 1"})`.
Each browser has its own queue and driver, so agents can operate different browsers
at the same time. Each agent uses one browser per Fez turn.
An instruction such as `@quill click Domains, then
@drift inspect the page` reserves their turns in that order, even if Drift asks
first. Observe waits for the agent's place and returns a fresh screenshot.
The owner strip shows the driver and waiting agents. **Take control** (or a
physical click while agents are queued) pauses that browser's queue; **Resume agents**
allows it to continue. Finishing a turn releases control automatically.
ACP injects `FEZ_AGENT_PERSONA`; Browser Use resolves only
`~/.fez/native-surfaces/<persona>.json`, which contains no owner-control token.
Tool discovery succeeds before a target is granted; actions then return a setup
error. The extension never searches for other browsers or takes over the physical
desktop.

In Fez Native, agent clicks show a pixel arrow with a monospace persona tag.
The tag's background, text and border follow the active theme immediately;
the arrow stays Fez orange. It moves to the target before
dispatch; tile corners flash when the click is sent. This native overlay stays
out of agent screenshots and does not move your
mouse. Taking control hides it and cancels a click still in transit. macOS Reduce
Motion replaces the movement with a stationary target indicator.

## Checkout development

```sh
npm run build --prefix packages/fez-browser
npm run build --prefix packages/fez-browser-use
node dist/cli.js link packages/fez-browser
node dist/cli.js link packages/fez-browser-use
```

The package is `@fezchat/browser-use`; attach it with the tool ID `browser-use`.
The native host still accepts legacy `computer-use` attachments. Their MCP
command must point to this package's `dist/mcp.js` after moving the checkout.
The old `FEZ_COMPUTER_USE_SESSION` variable remains a fallback for existing lab
configurations; `FEZ_BROWSER_USE_SESSION` takes precedence when nonblank.
`computer-use-prototype` and `browser-cef-prototype` belong to the older CEF lab;
the compatibility shim only keeps previously linked prototype definitions usable.
Camofox remains the Browser extension's agent-reading backend and setup flow.

```sh
npm run build --prefix packages/fez-browser-use
FEZ_BROWSER_USE_SESSION=/absolute/path/to/agent-session.json \
  node packages/fez-browser-use/dist/mcp.js
```

The explicit `FEZ_BROWSER_USE_SESSION` form above remains useful for the
identity-free lab and direct MCP testing. The integrated ACP path normally leaves
it unset and uses the injected persona instead.

## Surface contract

The runtime writes private, atomic `~/.fez/agent-runtime/<persona>.json` metadata:
effective tool names, current message ID and ordered addressees, turn state, and
a heartbeat. Prompts and credentials are excluded. The host accepts only live
processes with a heartbeat newer than 15 seconds. It creates persona descriptors
with mode `0600` and updates them when a browser opens or closes. It removes them
when the runtime stops, drops the tool, or no browser remains.
A descriptor permits requesting a slot, never bypassing takeover.
Legacy version 1 contains exactly `version`, `id`, `kind`, `label`, `endpoint`
and `agentToken`. `endpoint` is an explicit `http://127.0.0.1:<port>` origin, or a
`unix:///absolute/path/control.sock` socket beside the descriptor. Redirects,
remote endpoints, credentials and extra fields (including owner tokens) are refused.
Version 2 contains exactly `{"version":2,"targets":[...]}` with up to four
version 1 entries, each with a unique ID, `kind: "browser"`, and the native Unix
socket beside the root persona descriptor. Descriptors are limited to 8192 bytes.
Listing returns only `id`, `kind` and `label`; endpoints and capabilities stay private.

HTTP actions POST JSON to `/control` with the agent bearer capability. Native
actions send one newline-terminated `{id, token, action}` JSON request per socket
connection and read one JSON response; an `error` response clears the observation.
Legacy version 1 native requests retain the original `{token, action}` shape.
Observation returns `{ mode: "waiting", paused, driver, waiting }` until the slot
is available; Browser Use polls and respects MCP cancellation. Then it
returns `{ mode: "agent", epoch, data, viewport }`: a JPEG no larger than 1024
pixels on either side and `viewport.clientWidth/clientHeight` in input units.
The tool maps screenshot coordinates to those units. Input carries the observed
`epoch`; the host must reject it after takeover, resize, target replacement or
shutdown, including between the individual events of a click or keypress. Scroll
deltas are in the target's input units. The server serializes this MCP connection's
calls, clears observations on errors or changes to the observed target, and
requires observation before all input. It never retries input automatically.
Input must use the successfully observed target; supplying a different target
requires a new observation. Omitting `target` uses the last observed browser,
or the only available browser before any observation. If that browser closes or
is replaced, a version 2 session requires explicit selection again. Changes to
other catalog entries preserve the current observation and queued target.

An addressed agent that never starts its turn is skipped after two minutes;
completed or disconnected agents are skipped immediately. Browser ownership is
per Fez turn, not per click. The native host enforces one browser per agent turn.

The host is the enforcement boundary. The integrated native flow has private
transport, attachment-based eligibility, and owner pause/resume; the old CEF probe
still exposes raw CDP to trusted local processes. The upstream Tauri CEF runtime
is experimental. Normal desktop builds use system secret storage; disposable labs
use mock storage. Browser Use operates browser panes only. Full desktop control
is separate future work, reserved for a Computer Use extension.

## Checks

```sh
npm run check --prefix packages/fez-browser-use
npm test --prefix packages/fez-evals -- tests/browser-use.test.ts
FEZ_CEF_EXECUTABLE=/path/to/cefsimple.app/Contents/MacOS/cefsimple \
  npm test --prefix packages/fez-evals -- tests/cef-pointer.test.ts
```
