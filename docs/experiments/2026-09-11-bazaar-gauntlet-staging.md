# First Bazaar coordination gauntlet: staging review

Status: this proposal was approved and consumed by the [first rehearsal](2026-09-11-bazaar-gauntlet-rehearsal.md). It was rejected before the speaker handoff, with USD 0.500994 reported coordinator usage. The proposal and pre-run verification below are retained as reviewed; they do not authorize another attempt.

## The proposed job

One explicitly designated `brief-script-speech/v1` job uses the actual `fez` coordinator and `speaker` specialist. It reuses the completed speaker workflow through the existing Bazaar worker, collector, mandatory acceptance scorer, and versioned coordination attestation. The fixed script tests integration; it does not establish writing quality, specialist-selection quality, or general coordination superiority.

> Welcome to Fez, where every agent has a public-key identity and every message it sends is signed. That means you can connect custom agents with different capabilities, and hand work to the specialist whose tools fit it best.

| Participant | Actual runtime and enabled tool groups | Proposed allowance |
| --- | --- | --- |
| `fez` | Claude Code, `claude-opus-5`; `bazaar`, `fez` | USD 1 across at most two coordinator invocations |
| `speaker` | Claude Code, `claude-opus-5`; `fez`, `speech` | USD 1 for one invocation, 180-second timeout |
| Speech synthesis / specialist service | Existing macOS speech engine; explicitly sponsored service | USD 0 speech API fee; 0 tTAO service transfer |

These are **provider-reported usage stopping thresholds, not hard billing caps**. A provider call can exceed a threshold before reporting its usage. Missing cost remains unknown and stops further coordinator work. Reported model usage is not an invoice; separately billed tools are outside that meter. This rehearsal authorizes no other paid tools, no automatic retries, and no service transfers. The job deadline is 15 minutes.

The observed model is pinned only for staging; neither persona's saved configuration is edited. Both readiness probes return `ready: true` with no missing tools. Their configuration hashes are:

- `fez`: `b0581937d73a5bdacbf5a551bdf13c749dfe0491c64bf0cbf493d7421e71a00b`
- `speaker`: `d8a4b8ee9521f45c65e59b3a7b38a424bef1de0cd624960079e2d8c52ac74995`

The exact job and proposed allowances are frozen in `/private/tmp/fez-bazaar-staging-20260911T024004Z/operations/job.json`, SHA-256 `adbd652c7ad5c36ab991e0c11870d72db16050d61efb287bb92e9a5ced84a86d`. It passes Bazaar's existing job parser. Its signing window is September 11, 2026 at 03:00 UTC through September 13 at 03:00 UTC; an expired job must be refreshed and reviewed before execution.

## Isolation and attribution

The Mac runs the actual agents and the existing independent speech observer. A fresh workspace relay must explicitly bind `127.0.0.1:17777` through the existing `startRelay({host: "127.0.0.1", ...})` API; the current relay CLI omits a bind host. It uses a new store, one evaluation channel, and the existing owner/agent public identities. It is absent from normal workspace settings and the sentinel. Ordinary standing agents therefore do not receive this evaluation. Both built-in Fez tools and the existing speaker tool inherit this evaluation relay. The existing public audio host is restricted to `blossom.primal.net`.

The operator launches the specialist exactly once after observing the coordinator's signed assignment, using the same evaluated persona/runtime/tool configuration and its separate model allowance. The coordinator's signed assignment marks its result as externally handled, so ordinary ACP callbacks do not start an additional coordinator invocation. Evaluation invocations receive fresh scratch space and the supplied job context. Enabled tools are preserved; this is not an operating-system sandbox for arbitrary hostile tools.

The market, workspace, metrics, and attached Bazaar tool must all use this private relay: setting only `FEZ_RELAY` leaves Bazaar's default pointed at the public market. The reviewed environment is saved in `operations/worker-environment.review.json`. Use a fresh state file and no inherited miner secret override. The relay uses ordinary signature verification and owner-advertised roster/channel/attestations, without optional membership read gating: the current Bazaar relay clients do not authenticate NIP-42 reads. No ordinary sentinel or legacy router is started.

A rehearsal passes only after both Bazaar acceptance and a known, within-allowance speaker usage record. The speaker can publish its result before its model usage arrives. Save that usage separately: the current Bazaar coordination score records coordinator compute cost and specialist service fees, not specialist compute cost. Stop the operator watcher and worker after one terminal result or the deadline.

The existing validator's private key stays on its DigitalOcean host. A private staging signer accepts only the frozen, explicitly approved job. No approval file has been created. The local validator retains the existing artifact fetch, event read-back, WAV decoding, transcription, and mandatory acceptance checks. It publishes `coordination-speech/v1` evidence with `rewardStatus: not-submitted`; this path has no chain or corpus writer.

The signer confines event kinds, exact tags, job/request binding, participant identities, and the execution window. An exclusive lock and persistent job hash prevent parallel calls from creating extra jobs. It remains a signing transport, not a second artifact assessor. A submitted configuration mismatch is refused by this staging signer and must be retained locally as a failed rehearsal for review; do not retry signing or substitute an accepted result.

## Owner custody and economic status

The local owner identity is `2d4c2942d379634c2f8204d85cfdaaf25058e8620ad43e5553f1ac774263f941`. The coordinator and specialist keep their existing keys. Read-only inspection found no current public Bazaar enrollment binding for this coordinator and no configured coordinator mining hotkey/payout destination. The normal worker's signed enrollment must be observed on the private rehearsal relay before the directed job can be posted. Public enrollment, chain registration, and payout configuration remain separate, owner-controlled work and are not authorized by this rehearsal.

The existing wallet mirror contains an owner treasury address; no wallet, stake, or key-custody changes were made. No mining earnings or chain credit is claimed. Sponsored specialist work is recorded as sponsored, not paid. Measured job quality, accepted specialist capability evidence, SALT, and chain-verified stake remain distinct. Existing same-owner SALT exclusion remains applicable.

## Staged artifacts and verification

Local release: `/private/tmp/fez-bazaar-staging-20260911T024004Z`. It contains the final Bazaar bundles, a separate Fez runtime with its matching MCP/core dependencies, a frozen job, artifact hashes, and test/readiness/audio evidence. External dependency symlinks and the actual owner-enabled specialist executable remain local; the release manifest records them. Recheck hashes and readiness before execution. The installed app/runtime has not been replaced.

DigitalOcean release: `/root/fez-gauntlet-staging/20260911T024004Z` on the existing `fez-bazaar` droplet (`137.184.153.150`). The directory is private to root. The final Linux miner/validator, existing web assets, and checksum file were uploaded and verified. Empty-environment startup probes stop before keys, providers, or relay work. The current live binaries, service configuration, environment-file hashes, and all seven service process IDs/start times match the pre-staging snapshot. No new infrastructure was provisioned.

- Fez: **1,743 evals passed, 6 skipped**; root typecheck passed; core plus **45 packages** built.
- Bazaar: **337 tests passed** across 40 files; typecheck and all builds passed.
- Actual staged worker preview and speaker runtime preview both passed without inference.
- The previously completed WAV passed fresh independent decoding, non-silence, and macOS transcription checks. This checks the observer, not a new gauntlet outcome.
- The private staging signer passes **7 fixture checks**, including concurrent callers and actual accepted/rejected attestation output. Its final bundle and job hashes match on DigitalOcean; remote checks confirm no approval file and no signed-event state.

Staging caught and fixed dropped Claude ACP cost observations, task-tag dispatch to the speaker, duplicate coordinator callbacks, and explicit selection of the staged runtime. Regression tests cover those paths. Original uncommitted work in both repositories remains in place; no commits were created.

Next action: approve or decline this one live rehearsal, including possible provider-call overshoot of the two USD 1 usage thresholds. Ken's original prohibition on new paid runs is the reason execution remains paused.
