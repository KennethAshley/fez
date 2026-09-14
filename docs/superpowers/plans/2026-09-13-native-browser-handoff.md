# Native browser extension and handoff

User approved continuing from the working native pane to the existing browser
extension and computer-use extension. Keep this behind the isolated CEF build.

1. [x] Extend the existing computer-use transport to a private Unix socket next to
   its descriptor. Preserve HTTP compatibility; test real transport and revocation.
2. [x] Add the desktop native-surface API and browser extension renderer. Use the
   same provider/renderer in the development host and the desktop extension loader.
   The extension may navigate and arrange its browser, but cannot grant agent control.
3. [x] Give the native host a separate trusted owner-control view and grant epoch.
   Validate each agent input on the CEF UI thread. Real input within the native
   browser revokes the grant before dispatch; resize/hide/close/reload revoke too.
   Document/address changes retain the grant but invalidate observations; native
   minimize/app-hide notifications revoke even without intervening MCP requests.
4. [x] Test real MCP input, rejection before grant/after takeover, fresh-observation
   requirements, browser-only lifecycle and both command boundaries. Build, review,
   run typechecks/full evals, and leave the development preview available.

The production runtime dependency remains stable. The development build uses the
already pinned upstream CEF runtime. No commit, push, deployment, real-account
startup or replacement of the installed app is part of this turn.

Verification: core, desktop, browser and computer-use typechecks passed; full
evals 2,451 passed / 11 skipped; real native MCP regression passed; 14 existing
Rust isolation tests passed. Physical mouse takeover and the host Take control
button both refused the existing MCP client's next input. The lab preview uses a
fresh profile with external debugging disabled and starts in human control.

The full gate exposed an unrelated fixture collision: workspace-providers briefly
served port 7898 while multi-relay assumed it was unused. The failure tests now
own a rejecting ephemeral endpoint; their focused pair and the full suite pass.
