# Coordination-miner testnet deployment

Deployed on 2026-09-11 around 04:04 UTC under Ken's explicit testnet-only deployment authorization. The existing Bazaar server and installed Mac extensions now contain the coordination-miner implementation. No new paid gauntlet job was started or coordination reward policy activated.

## Verified deployment

The server's installed Bittensor SDK 11.1.0 and an independent official RPC read agree on testnet. Subnet 553 exists.

| Property | Verified value |
| --- | --- |
| Network | `test` |
| Subnet | `553` |
| Endpoint | `wss://test.finney.opentensor.ai:443` |
| Genesis | `0x8f9cf856bf558a14440e75569c9e58594757048d7b3a84b5d25f6bd978263105` |
| Server | `fez-bazaar`, `137.184.153.150` |

The validator's systemd drop-in explicitly pins `BAZAAR_CHAIN_NETWORK=test` and `BAZAAR_NETUID=553`. Its new startup guard verifies those settings, the SDK endpoint, genesis, and subnet existence before starting the validator. The actual startup guard exited successfully at 04:04:14 UTC. Negative checks refused mainnet, a mainnet URL, a wrong subnet, and an unset network.

All four existing miners and the validator were active with the expected running executable hashes. A public read of [Bazaar](https://bazaar.fez.chat/) matched the deployed board hash.

| Artifact | SHA-256 |
| --- | --- |
| Miner | `5a73266d42565d7c8e6ffa5e5d6d2e6c2cde80826c2a7217b6725a6e9c757d13` |
| Validator | `4a80ca96416915aa13b66fc71e8c23c1a9fe12b95494516ca489e9c417c28263` |
| Board | `1f0939db2dba3a13f8c5c18585cc14d64cf45eb407c0776acbb6efe7b4bbfb8e` |

## Installed Mac workflow

Thirteen runtime, Bazaar, and wallet artifacts were installed with backups and verified hashes. A dedicated evaluation runtime at `~/.fez/runtimes/bazaar-coordination-20260911` preserves the desktop's global runtime. The installed desktop application was not replaced or restarted.

Both installed previews passed without inference: `fez` exposes `bazaar` and `fez`; `speaker` exposes `fez` and `speech`. Both reported no missing tools. The evaluation launcher preserves explicit model selections and uses the previously rehearsed `claude-opus-5` only when the Claude runtime reports no selected model. Saved personas and global settings were not changed. The wallet remains configured for the official testnet endpoint.

| Persona | Installed configuration hash |
| --- | --- |
| `fez` | `c6769c5d5a28c8c318953b62e1475a3bee3ba7731aba16c1190f9db43b1390db` |
| `speaker` | `f29c1bf74065090934f89b89fc65ba020c561dda1498df1b6fe53d459e6646be` |

Reload Bazaar in Fez to load its refreshed GUI bundle. Future reviewed jobs must use these installed configuration hashes. The previews show owner-controlled destinations but no configured hotkey destination; this deployment does not establish registration or earnings.

## Verification and boundaries

- Bazaar: 342 tests passed; typecheck and builds passed. Fez: 1,753 tests passed, six skipped; typecheck passed. The Fez suite required permission for its local loopback fixtures after the sandbox denied them. Two local deployment/launcher fixture tests passed.
- Original server environment files, base service units, chain sidecar, relay, and web server configuration retained their hashes. Relay and web server processes were unchanged. Local profiles, wallet settings, and global runtime artifacts retained all eight protected hashes. Repository changes were preserved; no reset or commit was performed.
- Existing standing testnet research services continue under their existing configuration. No coordination job, gauntlet, model allowance, or service authorization was added to their environment. Spend ledgers and signed outcomes were not restored or reset. Stake, SALT, service payments, and measured quality remain distinct.
- The earlier free full-validator replay accepted the existing spoken deliverable; this deployment used previews and read-only verification, not another paid trial. Native speech observation remains on the Mac. New paid work and coordination reward activation still require authorization.

## Evidence and rollback

Compact verification records, artifact manifests, and the installed startup guard are retained in [the evidence directory](./2026-09-11-bazaar-testnet-deployment/). The prior replay is recorded in [the second rehearsal report](./2026-09-11-bazaar-gauntlet-rehearsal-2.md).

Server release, deployment script, original artifact manifest, and backups: `/root/fez-testnet-deploy/20260911-coordination` on the Bazaar host. The rollout waited for an idle round, atomically replaced artifacts, and restarted only the existing Bazaar services. Its rollback restores artifacts and deployment-specific systemd changes, checks testnet before restarting, and never restores spend ledgers.

Local artifact backup: `/Users/ken/.fez/backups/bazaar-coordination-2026-09-11T04-03-22-942Z-90297`. Full local preparation files and test logs: `/private/tmp/fez-bazaar-testnet-deploy-20260911`.

## Public manual publication

Ken subsequently narrowed the product-surface rollout to **docs.fez.chat only**.
The manual and its new [Bazaar & coordination miners guide](https://docs.fez.chat/concepts/bazaar)
were published as Vercel deployment `dpl_9KduWYsEBLBDeekBHDS95k8yyMN5`.
The docs project's incorrect Root Directory (`web`, the marketing app) was
corrected to `web-docs`; no other project setting changed. The source upload
contained only 51 documentation files, excluding local environment files and
private experiment records.

Local and remote builds passed (80 static pages), as did the docs typecheck.
The protected deployment's guide was verified before the live browser and HTTP
checks confirmed the manual at its public domain. The runnable check is
`web-docs/scripts/check-public-pages.mjs`. The marketing deployment remained
`dpl_BmQ38XfrtYfERuRb96cSRvb2PU6Z`; no further GUI or Bazaar-board update was
deployed. No paid agent job, chain operation, or reward change was performed.

Release IDs, source manifest, before/after project settings and verification
records are retained in `/private/tmp/fez-coordination-product-20260911`.
Paused GUI/board work is saved there as `paused-gui-board.patch`; those four
working files were restored to their pre-subtask baselines, preserving existing
dirty edits. Marketing and other documentation edits already made remain local
and uncommitted.

## GUI and marketing rollout resumed

Ken subsequently authorized the GUI and marketing site. Those surfaces are now
published, with the public board sharing the owner's coordination evidence
parser and verifying event signatures before displaying outcomes. Accepted,
rejected, and unassessed coordination results remain separate from historical
research scores, service payment claims, SALT, and chain stake. Empty views do
not imply a scheduled or funded job.

| Surface | Installed or published revision |
| --- | --- |
| Bazaar GUI | SHA-256 `7324ca9a21b7028704e7ebb6316574cfe36c3f1c0c8fde460de61c0b4797dcac` |
| Public board HTML | SHA-256 `84ee066796b6f6db7056dc2167a6d89b88c98bff7119f7991e9aacb551f0e75e` |
| Shared board evidence bundle | SHA-256 `778e4967e79566e0b4b67c7387e98adc207ab27d3632db6b26e2c373f3f3adab` |
| Marketing site | Vercel `dpl_6FDbvz6zMv75ZbRBaafUd2Er5z24` |
| Public manual, unchanged | Vercel `dpl_9KduWYsEBLBDeekBHDS95k8yyMN5` |

The GUI bundle was backed up and atomically installed. Native inspection first
confirmed that the open desktop still held the previous bundle. After checking
that its bundled runtime version matched the installed version and its agents
were detached, only the same desktop application was reopened. All six existing
local agent/relay processes survived, and all eight protected local files kept
their hashes. The new Coordination gauntlet section and per-agent outcome cards
were then observed in the running app. The actual `fez` review showed
`claude-code`, `anthropic`, `claude-opus-5`, enabled tools `bazaar, fez`, and the
previously verified configuration hash. Its allowance was zero and confirmation
was disabled. The review was canceled without launching a worker or model call.

Bazaar's complete suite passed: **347 tests, zero failures**. Typechecking, the
GUI build, and the browser evidence bundle build passed. Website typechecking
and scoped lint passed. The local production build hit a sandbox port-binding
restriction; the isolated 33-file upload built successfully on Vercel, including
all 13 static pages. Six changed marketing routes were checked on the protected
deployment before promotion, then checked again on `fez.chat`. The old
`/docs/concepts/bazaar` URL now redirects to the sole public manual at
`docs.fez.chat/concepts/bazaar`.

Live browser checks confirmed the marketing layout and the board's relay-fed
research results, four available agents, and honest empty coordination view.
No browser errors or warnings were observed on the board. Public HTTP reads
matched all three deployed board asset hashes. The validator remains on testnet
subnet 553; all five remote service PIDs and executable hashes were unchanged,
as were the testnet guard and service drop-in. No new paid job, specialist
payment, reward change, or repository reset/commit was performed.

Source manifests, verification records, full Bazaar test log, and the previous
GUI bundle are in `/private/tmp/fez-coordination-surfaces-20260911`. The server's
previous static assets and staged release are in
`/root/fez-testnet-deploy/20260911-coordination-surfaces`. Restoring the previous
board HTML first restores the prior board; the unused new helper may remain.
The previous marketing deployment is `dpl_BmQ38XfrtYfERuRb96cSRvb2PU6Z`.

## Bazaar GUI design and installed stylesheet correction

The requested frontend-design pass added a compact masthead, a visible speech
workflow, wider agent cards, readable offline records, and expandable details.
The send review appears above the roster with nearby error feedback. A local
sample-data preview was checked at narrow and wide widths without paid calls.

Native inspection exposed a difference from that preview: two installed
directories declared `@fezchat/bazaar`. The older copy inserted `bz-css` first,
while the newer copy replaced the view but skipped refreshing the existing
stylesheet. Activation now refreshes its owned stylesheet. The older copy's
manifest was backed up and only its `fez.parts.gui` entry was removed; its bundle
and other manifest fields remain unchanged.

The corrected GUI was installed with SHA-256
`1fabaa8d6c499a6a6da300ff480b2b067882acb0f82e5e91536df011b62c5a26`.
After reopening the same desktop application, native screenshot inspection
confirmed the compact artwork, spacing, readable two-column cards, and testnet
subnet 553 label. All six existing local agent/relay processes and all eight
protected local files retained their prior identities and hashes.

Bazaar's full suite passed: **349 tests, zero failures**. Typechecking and the
GUI build passed. Regression coverage verifies stylesheet refresh and visible
send-error placement. No new paid run, reward change, backend deployment, or
repository reset/commit was performed. Source hashes, test logs, installed bundle
backups, the legacy manifest backup, and native verification are retained in
`/private/tmp/fez-bazaar-design-20260911`.

## Theme-aware Bazaar atmosphere revision

Ken requested restoring the Caves of Qud-inspired mystic, nostalgic, futuristic
direction while retaining Fez themes. The GUI now reuses the existing pixel
wordmark, gives the original market scene a celestial frame, connects the three
workflow stages visually, and frames agent portraits and controls as terminal
panels. The artwork and panel colors derive from live host theme tokens; no
fixed dark palette or new font dependency was introduced. Existing spending,
acceptance, evidence, and reward behavior remains unchanged.

The installed GUI SHA-256 is
`0a919df8d2ba95232ecb9fd531f676e1112360a31d94991016ec61f7f283aa1b`.
Native screenshot inspection confirmed this design in the actual desktop app.
Local visual checks covered default dark/light, Dracula dark and Solarized
light, including theme changes while a send review remained open. At 360px,
the page and review had no horizontal overflow; the zero allowance continued
to disable confirmation. All **350 Bazaar tests passed**, with typechecking
and GUI build also passing. The suite needed loopback access for its existing
free local relay fixtures. The eight protected files and six existing detached
agent/relay processes were unchanged after reopening the desktop.

Backups, design notes, source hashes and verification records are in
`/private/tmp/fez-bazaar-atmosphere-20260911`. No new paid run, reward change,
backend deployment or repository reset/commit occurred.
