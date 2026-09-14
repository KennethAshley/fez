# Browser desktop integration implementation plan

**Current naming:** Browser Use (`@fezchat/browser-use`, MCP tool `browser_use`). Earlier Computer use names below record the original implementation and test history. Full desktop Computer Use remains separate future work.

**Goal:** Open the native browser from the real Fez extension workspace and connect a selected local agent to its computer-use tool.

**Architecture:** Keep Tauri and the pinned CEF development build. Move the proven native host into the desktop shell behind a build feature; both the lab and full desktop use it. The browser package supplies `/browser` and its pane. Computer use stays a separate installed MCP extension, receiving the current persona from the agent runtime and reading only that persona's explicitly granted descriptor.

**Spec:** `docs/superpowers/specs/2026-09-13-shared-browser-computer-use-design.md`. User approved integrating the lab on September 13.

**Constraints:** Preserve Camofox setup/tools, existing installed app, owner-only grant controls, native takeover and isolated-webview guards. No publish, release deployment or messages to other people. CEF remains experimental; development packaging uses the pinned upstream runtime.

1. [x] Package the real browser GUI. Reuse the declarative settings renderer through a generic GUI API, retain Camofox setup, and register `/browser`. Test installed extension activation, URL navigation and panel disposal before implementation.
2. [x] Bind computer use to its Fez persona. Inject host-owned `FEZ_AGENT_PERSONA` into stdio MCP configurations. Resolve a persona-specific descriptor beside the native socket. Test missing/invalid identity, distinct personas and replacement grants.
3. [x] Integrate the native host. Share the lab implementation with a feature-gated desktop module, add the trusted local-agent selector, and revoke/remove old descriptors on takeover. Add a full-desktop mode to the existing staging build. Extend the native regression to check grant switching and lifecycle using the shared host.
4. [x] Build and verify. Run desktop/core/tool typechecks, full evals, native MCP regression, a full desktop build and UI checks. Request code review and fix actionable findings. Leave the full development app ready for local use; document remaining release gates.

Checks use `packages/fez-evals/tests/cef-gui.test.ts`, `computer-use.test.ts`, `tauri-cef.test.ts`, and the existing MCP path/GUI loader tests. Before completion run `npx tsc --noEmit`, `npm run evals`, and the opt-in native test with `FEZ_TAURI_CEF_PROBE` pointing to the bundled executable.


## Verification — September 13

- Root, Browser, Computer use and desktop typechecks/builds passed. Full evals: 289 files passed, 2,464 tests passed, 11 skipped. Browser installation/settings/agent-attachment Playwright test passed against the actual packaged GUI.
- Native CEF regression passed through real MCP capture, click/type/save, takeover, resize/hide, command isolation, and clean process exit. The shared host's Rust grant test checks distinct persona capabilities, private file permissions, name validation and descriptor removal.
- Full Fez Native launched with the existing local profile. `/browser` loaded a real page and a localhost form in the workspace pane; the owner controls rendered. Native Quit confirmation and clean process exit with the browser open were verified.
- Fixed integration findings: plugin-setup window deadlock; duplicate macOS Quit hook; packaged GUI ESM fallback incompatibility; resize handle mistaken for an overlay; input-monitor retain cycle during shutdown; picker options replaced during focus.
- A separate automated full-desktop handoff attempt could not attach its remote debugger: CEF reported remote debugging disallowed by the system administrator. No policy was changed. Named grants are covered by host/unit tests; actual native input is covered by the lab regression. The subsequent manual owner handoff below verifies named-agent access without remote debugging.

The local Browser install retained its legacy `fez-browser` name and Camofox configuration; its GUI bundle/manifest and command grant were updated in place after a private backup. Computer use was linked separately. No agent attachment, external message, commit, push or release was performed.

Release remains gated on the experimental runtime's distribution support, signed-app/Keychain testing and browser popup/download/permission policy. The staged build is debug-only, uses mock browser secret storage, and normally has external debugging disabled.


## Manual handoff confirmed

The user requested attaching Computer use; it was attached to the local `fez` persona using the shared attachment helper, preserving Bazaar and Kanban. The agent was restarted through its runtime controls, and its log confirmed `computer-use` attached.

After the user selected `@fez`, the trusted native control strip granted access. The installed MCP executable, launched with `FEZ_AGENT_PERSONA=fez`, returned an actual browser screenshot (654×739). A separate client bound to `quill` was denied. Taking control through the owner strip removed access, and the `fez` client was denied on its next observation. These were direct MCP integration checks, not a model-generated agent task. The browser was left under human control.

## Live Fez agent task verified

The first actual chat request failed despite those direct MCP checks. Claude's startup diagnostic reported: `"computer-use" is a reserved MCP server name and was not loaded`. Fez now maps that server name to `fez-computer-use` at the Claude harness boundary, after credential resolution, in both persistent sessions and one-shot invocations. Persona attachments and other harnesses retain `computer-use`.

Rebuilt and launched Fez Native with bundled agent `0.84.2+svc27`. Through the real workspace UI, selected `@fez`, granted browser control, and sent the original request without diagnostic hints: “@fez click Learn more in the browser and tell me what page opens”. The agent called `mcp__fez-computer-use__computer_use`, clicked the link, inspected the resulting page, and replied that it opened IANA's Example Domains page. The visible browser independently showed `https://www.iana.org/help/example-domains`. This was a live Claude-backed Fez agent turn, not a direct MCP test.

Validation: root typecheck and build passed; 24 focused checks passed; full evals passed with 289 files and 2,465 tests (11 skipped). The native app build passed. The regression checks Claude's name mapping, preservation of process configuration, and unchanged names for other servers/harnesses.

## Visible agent cursor verified

The native browser now draws an orange arrow and controlling persona label above
the page. Each click moves the pointer for approximately 180 ms before dispatch,
then pulses on the same native dispatch path. Epoch checks remain active during
movement; human takeover hides the cursor and cancels a pending click. The
overlay passes through physical input and is excluded from agent screenshots.
macOS Reduce Motion keeps the indicator stationary at the target.

The native regression passed through real MCP and CEF: it checks coordinate
alignment, screenshot exclusion, and takeover during movement with no click
delivered. Root typecheck, the full eval suite (2,465 passed, 11 skipped), and
both lab and full desktop native builds passed.

At 3:00 PM, a real chat request asked `@fez` to click Learn more. It opened IANA's
Example Domains page and replied with the correct destination. The visible
native cursor displayed `@fez` at the actual click location without obscuring
the browser. Human takeover removed it. Live evidence is saved locally at
`/private/tmp/fez-agent-cursor-live.png`; the development app remains open under
human control.

The follow-up visual pass replaces the smooth arrow and rounded orange label
with a two-point pixel sprite, square monospace tag, and stepped tile-corner
click flash. It uses Fez's charcoal, parchment and brand-orange palette. The
live 3:09 PM Fez click opened IANA and displayed the new cursor; evidence is at
`/private/tmp/fez-pixel-cursor-live.png`. Root typecheck, both native builds,
the native MCP regression and all 2,465 evals passed again (11 skipped).

The cursor tag now takes its background, text and border from the active GUI
theme (`--bg0` and `--fg`), including live theme changes. The main webview
resolves CSS colors to bounded RGB bytes; the native bridge validates their
shape and updates only the cursor palette. Arrow and click-flash colors remain
brand orange. Palette changes preserve the current grant, coordinates and
screenshot exclusion; takeover/regrant preserves the selected palette.

The native regression checks live light/custom color changes, short hex and
RGB syntax, malformed color rejection, screenshot exclusion and palette
retention after takeover. Its restore check now waits for the native child
to become visible before granting again. Root/desktop typechecks, both native
builds, the native regression, 11 focused GUI tests and all 2,465 evals passed
(11 skipped). A live 3:21 PM Fez click showed the light theme's tag on IANA;
evidence is `/private/tmp/fez-themed-cursor-live.png`. Control was returned to
the human. The development restart returned to the default GUI theme.

Attachment-only access and multiple-agent scheduling were discussed as future
UX changes. This pass retains the current owner selector and explicit grant.
