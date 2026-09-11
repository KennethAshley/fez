# Numinous submission adapter implementation plan

Goal: make the accepted testnet Numinous miner manageable through Fez chat tools and GUI.
Approved design: the user's "build the adapter" accepts the preceding shared-adapter proposal.

Architecture: an optional submission surface on installed miner descriptors owns status,
isolated testing and upload. fez-mining provides generic CLI/MCP/UI access. Submission
entries have no runner, machine or process restart semantics. Numinous ships as its own
extension, fixed to testnet155 and staging SIGNAL. Existing uploaded versions are adopted.

Constraints: preserve unrelated work on codex/actions; no commits/pushes, extra rentals,
new live uploads or registration burns in implementation verification. No secrets in
GUI, state or MCP. Read-only wallet access must not create a key. A submit requires the
exact SHA256 of successfully tested bytes; upstream cooldown remains enforced. Docker
tests are networkless and keyless, never execute candidate code directly on the host.

## Work checklist

- [x] Adapter: packages/fez-numinous (descriptor, staging client, isolated Docker test,
  README and focused tests), plus wallet export-hotkey --existing read-only support.
- [x] Harness: optional MinerSubmission contract; submission CLI verbs; durable status
  in MinerEntry; exclude submissions from runner supervision; MCP tools scoped to persona.
- [x] UI: submission launch/management pane from catalog, fleet and thread, status and
  versions, test/submit actions; keep existing container controls unchanged.
- [x] Verify: focused failure/security tests, typechecks/builds, full evals, independent
  review, read-only live adoption of Drift's existing testnet submission. No upload.

Contract is defined in packages/fez-extension-api/src/miner.ts. Adapter changes and
harness/UI changes have disjoint write sets. API status is not evidence of scoring;
copy must distinguish pending activation, active version, and unverified execution.
No pause/delete is offered because upstream cancellation semantics are not verified.

Ruling: work in the current codex/actions checkout to preserve the in-progress mining
prerequisites; do not stage, reset or commit unrelated changes.

Harness verification: 8 behavioral evals (including concurrent adoption, stale errors,
and positional-argument parsing), 1 real stdio MCP eval, 9 mounted GUI evals, and the
skill-resolution eval pass. Mining suite: 172 passed / 7 skipped. Adapter: 47 tests,
built-ESM SR25519 check, typecheck and build pass. Wallet: 360 tests pass locally,
independently typechecked and rebuilt. Three wallet tests pin testnet-only
metagraph reads to the exact validated configuration snapshot. Root typecheck passes. Independent harness
review passes, including the shared state-lock changes. Fixtures never register
against a real chain.

Integration finding: the local skill catalog uses `fez-mining`; bare `mining` in persona
frontmatter was unresolved. The shared helper now writes `mining=npm:@fezchat/mining`.
An eval uses the actual persona parser and installed-skill resolver to prove both link
and npm catalog names resolve; existing bare declarations are upgraded idempotently.

Local verification, 2026-09-10: linked numinous, mining and the wallet's existing-key
read mode. Adopted Drift's existing UID76, version 14cfd757-78a3-4f46-9cfa-115ff0142ec8,
pending activation. No upload or registration. The other miner's saved entry is
hash-identical before/after. Live MCP mining_status sees the adopted submission.
Drift's persona now declares the canonical mining capability; no chat messages sent.

Rendered the actual GUI bundle with mock data at widths 960 and 560: no browser
errors or horizontal overflow; improved form spacing and full-width source input.
The adapter's exact sandbox command ran the public, SHA-verified 0.5 baseline on
the existing Docker host with no network/keys. The Mac itself has no Docker CLI;
GUI testing new candidates requires local Docker and the documented pinned image.

Full eval gate attempted: 1,442 passed, four failures in the separate in-progress
conversation-isolation suite. Log: /private/tmp/fez-numinous-final-evals.log.
No mining failures; the full repository gate is not claimed green.

Independent adapter review identified a wallet-network-change race in optional
UID enrichment. The adapter now passes `metagraph --require-testnet`; the wallet
validates network and endpoint in the snapshot it actually connects to. Changed
preferences fail before opening a mainnet connection, leaving the staging status
available without a UID. Both wallet and adapter regression tests cover this.
The fix passed independent re-review; live status again returned UID76/pending
through the guarded wallet call. The temporary sandbox is gone; Gradients,
searxng and valkey remained running. Installed GUI and headless bundles match
the built source hashes. No commits or pushes made.
