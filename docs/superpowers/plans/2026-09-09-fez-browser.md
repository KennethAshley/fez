# Fez Browser Implementation Plan

> **For agentic workers:** Implement inline with the test-driven-development
> workflow. The user has authorized creating and integrating the extension.

**Goal:** A Fez agent can open The Verge, read the lead headline and link,
and close its browser session through an installed extension.

**Architecture:** One MCP factory owns a Camofox session and its allowed tab
IDs. A stdio entrypoint owns process shutdown. Use Fez's existing skill
manifest and npm build discovery.

**Tech Stack:** TypeScript, Node fetch, installed MCP SDK and Zod, Vitest.

**Spec:** ../specs/2026-09-09-fez-browser-design.md

## Global constraints

Package `@fezchat/browser` in `packages/fez-browser`; browser behavior stays
in the extension. The GUI follow-up adds generic managed Node provisioning
to the existing desktop extension process runners.
HTTP(S) page URLs only; remote server connections use HTTPS and an access
key; no REST redirects. Four tabs, 55-second requests, 2 MiB responses and
80,000-character native snapshot windows. Authenticated grants are out of scope.

## Task 1: Browser session and MCP tools

Files: `packages/fez-browser/src/index.ts`, `src/mcp.ts`, `package.json`,
`tsconfig.json`, `tsconfig.types.json`, `README.md`, and
`packages/fez-evals/tests/browser.test.ts`.

Interface: `createBrowserServer({ baseUrl?, accessKey? })` returns
`{ server: McpServer, close: () => Promise<void> }`. The three tool names
are `browser_open`, `browser_read`, and `browser_close`.

- [x] Write failing MCP integration tests using a local HTTP server and
  `InMemoryTransport.createLinkedPair()`. The contract fixture returns
  `{ tabId: "tab-1", url: "https://www.theverge.com/" }` from `POST /tabs`
  and a snapshot containing a headline and article link. Assert that
  `client.callTool({ name: "browser_read", arguments: { tab_id: "tab-1" } })`
  returns both. Assert unknown tabs produce a tool error without HTTP calls.
- [x] Run `npm test --prefix packages/fez-evals -- tests/browser.test.ts`
  and confirm the missing implementation fails.
- [x] Implement the factory, validated HTTP client, owned-tab tracking,
  serialized calls and full-session cleanup. Bundle the stdio entrypoint
  with the same esbuild pattern as `fez-web`.
- [x] Run the targeted tests and package typecheck/build until passing.

## Task 2: Integrate and verify

- [x] Add README setup: Camofox runs separately, persistence off, localhost
  binding, access-key custody, `fez link` and `mcpServers: [fez-browser]`.
- [x] Run `npm run build`, `npx tsc --noEmit`, and `npm run evals`.
- [x] Run the compiled stdio MCP against Camofox 1.14.0: call open/read/close,
  inspect the returned lead title/link, and verify upstream tabs are gone
  after MCP shutdown. Keep the upstream browser in the temporary probe dir.
- [x] Run `node dist/cli.js link packages/fez-browser --no-build`; verify
  only this package's catalog entry and permission declaration were added.
- [x] Review the diff and record the actual check results in the final
  response, including any unrelated gate failures.

## Verification results — 2026-09-09

- Full build: core + 44 packages passed. Package and root typechecks passed.
- Full eval gate: 1,394 passed, 1 skipped; includes all 12 browser tests.
- Compiled stdio MCP live test: passed against Camofox 1.14.0 in three
  seconds; read The Verge, closed the tab, and removed the session including
  an unlisted popup on shutdown. The test caught and corrected an upstream
  detail: complete snapshots omit pagination flags; preserve native cursors.
- Linked `fez-browser` into the local Fez catalog. Verified its command,
  absolute bundle path, environment names and permission declaration;
  asserted that all unrelated settings were unchanged.

The temporary Camofox server was stopped. No persona was selected or
modified. Normal use requires a running Camofox server and attachment to
the intended persona, as documented in the package README.

## Follow-up: Quill attachment — 2026-09-09

The user selected Quill. Added `fez-browser` to Quill's existing tool list
without changing its other tools or prompt. Installed the tested Camofox
runtime at `~/.fez/camofox`, disabled persistence, and started it on
`127.0.0.1:9377`. Its access key is in the existing Fez skill keychain.
No startup-at-login service was installed; restart after reboot with
`node ~/.fez/camofox/start.mjs`.

Verified Quill's saved persona through Fez's compiled parser and keychain
resolver, then ran the registered MCP bundle to open/read/close The Verge.
This checked Quill's tool configuration; no message was sent as the user
and no Quill model turn was started.

## Next milestone: desktop workflow

The user requires setup and use through the Fez GUI. The terminal runtime
setup above is temporary. Implement and verify GUI browser setup,
readiness/recovery, and use through the existing agent tool picker and
conversation. See the spec's “Required desktop workflow”; the completed desktop
checks below are separate from the earlier MCP-only checks.

### GUI implementation checklist

- [x] Add a setup/status/test program to the Browser package, using the
  existing GUI process permission and background-job runner. Install the
  pinned Camofox runtime privately; download the browser only after the
  owner clicks Set up browser, with progress and retry in the panel.
- [x] Start an isolated local Camofox process on the first browser call;
  stop it with the MCP connection. An explicit server URL retains the
  remote/external-server path. No service or manual reboot command.
- [x] Add Browser to the gallery and a settings panel using Fez's existing
  styles and agent tool picker. Keep secrets and process details out of
  the webview. Make missing setup and failures actionable in the GUI.
- [x] Run lifecycle and GUI checks, full build/typechecks/evals, and the
  live Verge check from the installed bundle with no shared server.
- [x] Link the finished package for Quill and verify the desktop flow;
  prepare the distributable package and report any release prerequisite.


## Desktop verification — 2026-09-09

- Browser MCP boundaries, subprocess lifecycle, hard parent death, and GUI
  permission/error checks pass. Root and package typechecks pass.
- Desktop webview walkthrough passes: install, setup, test, give to Quill,
  reload, and test again. The native installer is a fixture; setup/test use
  the real extension runtime against a local Camofox process fixture.
- A clean temporary directory installed all locked npm dependencies,
  downloaded Camoufox, and opened/closed a real blank page. The permanent
  local installation also passed setup and test.
- Quill's registered compiled MCP opened/read/closed The Verge and cleaned
  its process/profile. The old shared server on 9377 was stopped; another
  live check passed with that port closed. No Quill model turn was run.
- Full eval gate: 1,402 passed, 1 skipped. An earlier run collided with the
  GUI test relay; the walkthrough now allocates a free port. A subsequent
  run hit the existing relay-watch timing assertion under parallel build
  load; the final full run passed without source changes to that test.
- Rust library suite: 69 passed, 1 ignored. Full npm build: core + 44 packages.
- Linked GUI/bin/permissions for `fez-browser`; runtime reports ready.
  Asserted Quill and all unrelated settings were unchanged by this relink.
- Packed the self-contained extension to `/private/tmp/fezchat-browser-0.1.0.tgz`.
  The package remains private and unpublished; public gallery installation
  requires package publication and the updated desktop catalog release.

The manual startup instructions in the earlier attachment log are superseded.
On this machine, reopen Fez, then Settings → extensions → fez-browser →
Test browser. Browsing requests go through Quill's existing conversation.
The running installed desktop has not been replaced with a new native build;
the new panel uses existing host APIs and the already installed Node runtime.


## Release candidate — 2026-09-09

The owner verified a real Quill DM after restarting the standing agent;
Quill returned the lead Verge article and link. The stale desktop process
record was repaired locally, preserving Quill's channels and other agents.
An explicit restart step is now in the package README.

A release review found that a failed startup stayed cached across calls.
The candidate now cleans up and resets failed startup state, with a regression
covering missing setup, failed child cleanup, and concurrent retry on the
same connection. All 21 Browser tests pass; independent review confirmed
that the release blocker is resolved. The candidate is prepared on
`codex/publish-fez-browser` from `origin/main`, excluding unrelated local
web/documentation commits. Publishing uses the repository's targeted
`scripts/publish-batch.mjs` workflow, which strips `private` temporarily.

Final release gate: core + 44 package builds passed; root/package typechecks
passed; 1,403 evals passed (1 skipped); 69 Rust library tests passed
(1 ignored); GUI walkthrough passed. Targeted publish dry run passed.
The packed candidate installed through the actual native installer and
ran its setup-status executable and a live Verge MCP open/read/close check,
with cleanup verified.
