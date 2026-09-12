# Installed extension settings audit — September 12, 2026

The initial desktop security update did not migrate every installed extension.
Selection is driven by the installed `fez.guiRuntime` declaration; packages
without it still run their GUI in the main webview. Permission checks on that
legacy API do not provide the native boundary used by isolated settings.

## History

- `cd93719`: introduced extension permissions and the command-risk gate.
- `4705ca8` (August 30): added explicit crypto/Nostr permission checks.
- `e5e089d` (September 11): added the isolated settings runner, native caller
  guard, main-only plugin ACL, scoped broker, private browser storage and
  targeted channel delivery. GitHub and ElevenLabs declared the new runtime;
  absence intentionally retained the legacy host.

## Installed GUI parts at the initial audit

| Installed directory | Version | Current runtime |
| --- | --- | --- |
| fez-github | 0.1.1 | Isolated settings |
| slack | 0.1.0 | Isolated settings |
| elevenlabs | 0.1.1 | Legacy; predates its isolation declaration |
| bazaar | 0.3.7 | Legacy |
| fez-browser | 0.1.0 | Legacy |
| kanban | 0.1.3 | Legacy |
| mining | 0.1.4 | Legacy |
| ridges | 0.1.0 | Legacy |
| themes | 0.1.0 | Legacy |
| wallet | 0.1.15 | Legacy |

All ten had recorded grants. The initial read-only audit changed no installed
manifest or grant.
The installed ElevenLabs panel also lacks the `read:agents` grant required
by its current isolated replacement. Its migration needs the compatible
bundle and an explicit decision on that additional grant. Version numbers
alone do not identify the runtime; the manifest must be checked.

## Initial embedded settings change

Declared isolated panels now use private child webviews inside Settings.
GitHub and Slack also appear in the Settings sidebar; their channel settings
shortcuts use a larger in-app modal. Native caller identity, scoped storage,
permission checks, CSP, navigation restrictions and the restricted broker
remain in place. Main controls size, theme and visibility, closes panels on
navigation/unmount, and receives only a closed set of navigation shortcuts.

This does not sandbox executable extension parts or migrate the eight legacy
GUI installs. The previously measured WebRTC networking limitation remains;
the boundary isolates native authority and browser storage, not all traffic.

Verification: 2,350 evals passed with eight skipped, six browser flows passed,
nine native boundary tests passed, and the bundled macOS webview probe passed.
The probe confirmed one window, separate main globals/storage, denied native
and plugin calls, scoped config/secret routing and blocked popups/navigation.

## Kanban migration completed later on September 12

Kanban 0.1.4 is now installed with `guiRuntime: isolated-page`. Its board runs
inside a native child webview in Docs. The main app renders validated manifest
declarations for page matching, message summaries and code-block disclosures;
it does not evaluate Kanban's GUI code or CSS. Document writes are scoped to
the open current version and recheck native permission before publication.
Existing board data, daily schedules and permission grants were preserved.
Seven of the original eight legacy GUI installs remain unmigrated.

The updated app was Developer ID signed, notarized, installed and reopened.
Backup: `/Users/ken/.fez/backups/isolated-kanban.ABnbA5`. All 2,361 evals passed
(eight skipped), as did ten browser flows, ten native boundary tests and the
actual macOS page probe. In the installed app, Fez work opens inline and its
Backlog card opens full details. Verification made no live board writes.

## Remaining migration prepared on September 12

The approved model uses Fez-rendered standard controls and dialogs, with
custom UI in native child webviews inside the app. The following source and
staged changes are prepared; this section does not assert that they have
been installed or that the signed app rollout is complete.

| Extension | Prepared GUI migration | Preserved behavior |
| --- | --- | --- |
| ElevenLabs | `declarative`, `dist/gui.json` | Per-agent voice defaults, saved overrides and Fez-owned audio previews |
| Browser | `declarative`, `dist/gui.json` | Owned-binary setup, status, retry and test controls |
| Themes | `declarative`, `dist/gui.json` | Light/dark palettes in Appearance; validated colors, fixed fonts/layout |
| Bazaar | `isolated` with data-only navigation contributions | Its custom view and owned miner controls in a child |
| Mining | `isolated` with channel tabs, summary and thread contributions | Fleet summary, miners/subnets and thread management |
| Wallet | `isolated` with settings, four message contributions and one profile contribution | Consent, receive cards, receipts, address chips, Stake and backup ceremony |
| Ridges | Remove only installed `fez.parts.gui` | Installed headless, skill/MCP and background attachments |

The main loader validates declarative JSON and manifest contributions before
registering host-owned controls. It never evaluates these extensions' code or
CSS in the main webview. The custom adapter runs original callbacks inside
the selected child. Public channel snapshots retain the real message author,
content and timestamp, name resolution, receipts and the viewer's signed
reaction times. Reaction writes stay bound to the opened message. Refreshes
preserve React component state, including Wallet drafts and backup words.

Kanban card details and Wallet's Base mainnet confirmation use the shared
Fez-owned full-window dialog. Its fixed source identity comes from the native
session; title/body/context are plain text, and it loads no extension code or
styles. Wallet awaits the existing warning about REAL USDC and effective
per-call/daily limits before changing the network. Cancel or errors leave
preferences unchanged. This replaces `window.confirm`, which the pinned macOS
WebKit delegate does not implement.

Permission changes must reach recorded grants as well as manifests.
ElevenLabs's current source explicitly requests `read:agents`; the original
installed grants lacked it. Its other permissions remain
`network:api.elevenlabs.io`, `network:storage.googleapis.com`, `network:relay`,
`publish`, `read:channels` and `ui`. Wallet adds the explorer hosts
`network:taostats.io`, `network:basescan.org` and
`network:sepolia.basescan.org` to its existing requests. Its public RPC calls
continue using `.opentensor.ai` and `.base.org` grants.

Custom children receive CSP sources from recorded HTTPS/WSS hosts, including
declared subdomains and configured relay origins. Changed grants close the
custom view at its next broker check. The current native implementation
deliberately refuses `tauri dev`, whose server bypasses the per-view asset
response hook; a packaged macOS build is required. The measured WebRTC STUN
exception remains, and a separate webview need not be a separate OS process.

Owned-binary checks are not a full executable sandbox. Wallet's `processes`
grant already authorizes its CLI's commands, including spending and remote
hotkey export. New wallet initialization intentionally returns its mnemonic to
the isolated Wallet view for the owner's backup ceremony. The native boundary
prevents choosing another package's binary or invoking arbitrary Tauri
commands; it does not confine an allowed executable's keychain, filesystem or
network access. No live wallet process, payment or secret was used in this
migration's browser fixtures.

Ridges is staged at `/tmp/fez-ridges-no-gui.package.json`, copied from its
installed 0.1.0 manifest with only the GUI attachment removed. Copying the
current source manifest alone would add `dist/miner.js`, which the installed
package does not contain. The staged manifest preserves every installed
non-GUI field and permission; all retained entry files were checked.

Focused checks for the dialog/custom integration passed: 26 browser fixtures,
13 API-mirror/Kanban/reputation evals, desktop build/typecheck and Wallet
typecheck. The Wallet fixtures bundle the real source with mocked IPC and
disabled network: accept/cancel/error preserve policy correctly, and a fake
backup phrase survives snapshot refresh until acknowledged. Broader evals,
native probes and installation are recorded separately when complete.

## Signed rollout staged

The complete local app update is signed and notarized (Apple accepted submission `e0bf9c67-9dd3-425f-8457-e7df34af1f87`). Staged review record: `/var/folders/xw/b0sklf9s1xq8_63v0t0xk2gh0000gn/T/fez-extension-ready-9tqhz14j/REVIEW.json`. All 2,412 evals passed (eight skipped), 121 native tests passed (one ignored), 26 browser checks passed, and Browser setup/attach/reload integration passed. Native macOS probes cover settings, page details and custom views.

Automatic approval review stopped the installation before it ran, requiring specific user approval for the app replacement, restart and listed ElevenLabs/Wallet permission additions. Installed files have not changed in this rollout. The installer has rollback handling and preserves non-GUI attachments.

### Final layout regression checks

The migrated Mining/Profile integration fixtures now load actual isolated manifests and exercise the real host handlers and child runtime. Mining exposed two host layout defects: the sidebar resize handle overlapped the visibility sample, and a flex rule overrode inactive tabs' `hidden` attribute. Custom views now reserve a 4px inline inset and only visible channel tabs receive flex layout. Both integration tests pass with normal mouse clicks (8.7 seconds). The earlier notarized artifact is superseded; the corrected app is being rebuilt before installation.

### Remaining repository scope

This rollout targets all installed GUI extensions. Six additional, uninstalled first-party GUI packages remain active legacy sources; none is an obsolete fixture. All are built and listed for batch publication. The repository has 15 GUI packages: nine declare a migrated runtime and six do not. Bazaar's migrated source is in its separate repository.

| Uninstalled package | Existing GUI features | Additional migration seam |
| --- | --- | --- |
| Git | Repo settings, lane threads, activity chips, `/repo`, assignment, authenticated journal/diff/merge | Advertised Git host and scoped HTTP authentication, documents, thread/working state, watch and composer commands |
| Live Blocks | Interactive document fences, refresh comments, `/live` | Interactive block context, scoped document comments/writes and composer commands |
| Loom | Save actions, artifact library, open/share/import | Artifact actions/snapshots/events, scoped publication/opening and migration of existing localStorage saves |
| Obsidian | Palette and plain-text artifact viewer | Declarative artifact-viewer mapping or isolated artifact surface |
| Polls | Poll cards, member-filtered tallies, change-vote reactions, `/poll` | Full ballot/roster snapshots and scoped composer publication |
| Theme Fez | Palette with its original monospace font stack | Bounded font tokens to preserve its typography exactly |

These six have not been migrated by this installed-extension pass. A separate scope question is pending; this audit does not describe all repository extension sources as migrated.

### Corrected artifact ready

The two layout fixes pass the complete Mining mouse workflow and Wallet profile workflow. The corrected app is signed, notarized and stapled; Apple accepted `4e83e875-a541-44b7-af6d-fb1b7af85f8d`. All 29 browser checks pass. Review note: `/var/folders/xw/b0sklf9s1xq8_63v0t0xk2gh0000gn/T/fez-extension-ready-9tqhz14j/INSTALL.md`. Installation remains blocked on explicit approval; Fez is closed and installed files have not been replaced.

### Approved installation and final native verification

The owner approved the app replacement, restart and listed permission additions.
The installer completed, preserving the previous app and affected files at
`/Users/ken/.fez/backups/extension-migration.1cw3k33k`. All installed GUI extensions
now declare a migrated runtime; Ridges retains its backend attachments with its
obsolete GUI attachment removed. All other settings fields were unchanged.

Live checks verified Kanban's full-window details and Escape cleanup, embedded
Mining and Bazaar views, Wallet settings, Browser status, agent voice choices and
all 19 theme palettes. Some early Computer Use captures were white despite
responsive controls; later captures rendered normally without a rendering-code
change. The separate visible native probe also rendered the full-window overlay
and returned from three native webviews to two after Close. No orphan native view
was found. The cause of the earlier white captures was not established.

Opening Mining at the default 800×600 viewport exposed an initial-bounds error.
Initial panels now use the same viewport clipping as resize updates, and custom
containers can shrink below their former 320px minimum. The Mining and Wallet
profile browser workflows pass, including Mining at 800×600; all 14 native panel
tests and root/desktop typechecks pass. The actual-window native probe confirms
initial clipping with the existing one-logical-pixel rounding tolerance. The final
build was accepted by Apple (`d4c34d69-7b31-4d86-b024-44bed0f65169`), stapled,
installed and reopened. Final replacement backup:
`/Users/ken/.fez/backups/extension-migration.9gtihwfi`. The installed executable
matches the signed artifact; all settings match the preceding approved install.
Mining opens its native summary and Miners view after the final restart.
