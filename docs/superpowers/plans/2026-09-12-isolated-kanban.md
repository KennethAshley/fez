# Isolated Kanban migration

User approved the isolated-interface pattern and selected Kanban as the first
full-page migration. Execute inline; preserve the existing checkout changes.

## Design

Keep board semantics and rendering in the Kanban extension. Extend the existing
native child-webview host with a document-bound page surface. The main app owns
the selected document and signed save/comment callbacks; requests cannot name a
different document. Writes require a live publish grant, an editable current
version, and the exact version shown to the extension. Page changes notify the
child to read a fresh snapshot without remounting the extension.

An `isolated-page` manifest declares one page view, bounded document matching
rules, text-only message summaries, and code-block disclosures/menu templates.
Fez renders these declarations without evaluating extension code or CSS in its
main webview. Match semantics are shared with the extension's `isBoard` helper.
The full board bundle and its CSS execute only inside the native child. Preserve
drag/drop, card details, assigning, schedules, markdown fallback and live updates.

## Work

- [x] Add regression coverage for declaration validation, no main evaluation,
  document scope, stale/read-only/closed writes, native grant revocation and the
  shipped board's interactions in the isolated runner.
- [x] Implement declarative contributions and document-bound broker operations;
  reuse panel lifecycle, private storage, native caller guard and scoped config.
- [x] Migrate Kanban's manifest, bundle and CSS; keep the page mounted across
  content updates and preserve all existing document/history behavior.
- [x] Run typechecks, focused browser/native tests and the full eval gate. Review
  security-sensitive changes, build/sign/notarize, and install the tested update
  with a backup and unchanged permission grants.

## Verification

Run `npx tsc --noEmit`, the desktop and extension typechecks, `npm run evals`,
desktop Playwright tests for isolated settings/pages, and Cargo isolated-panel
tests. Exercise the actual macOS child webview with fixture documents before
installing. UI testing must not publish edits to the user's real board or send
agent assignments. No other extension migration, new permissions, merge or
release publication is included.

Verified: 2,361 evals passed (eight skipped), ten Playwright flows passed,
ten native boundary tests passed, and the real macOS page probe passed.
Root, desktop and Kanban typechecks passed. Review found and closed delayed
write authorization, missing/stale agent discovery, and pending-read grant
revocation gaps. The app is built and its Developer ID signature verifies.
The user approved the notarization upload. Apple accepted submission
`915b82c3-84ec-4774-8f1b-336195416eea`; its ticket is stapled and Gatekeeper
accepts the app as Notarized Developer ID. The user approved the restart,
including interruption of local work. Installed the signed app and Kanban
0.1.4; verified the installed GUI/manifest match the tested files and that
settings/grants are unchanged. Backup:
`/Users/ken/.fez/backups/isolated-kanban.ABnbA5`.

In the installed app, Docs → Fez work opens the board inline with a separate
`isolated-panel.html` native child view. Clicking the Backlog card opens its
full details. The existing daily schedule remains visible. No board edits,
assignments or schedule changes were made during verification.
