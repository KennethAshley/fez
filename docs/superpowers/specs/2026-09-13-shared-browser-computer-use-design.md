# Shared browser and computer use

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

## Verification

Use real MCP transport tests for extension composition, missing/invalid grants,
observed-coordinate input and revocation. Use opt-in native CEF integration tests
for rendering and input. Run core typecheck and the complete Fez eval gate before
claiming an implementation works. Native experiments remain feature-gated and
must not replace Camofox or the installed Fez application during development.
