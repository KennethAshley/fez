# Bazaar wallet-backed hire — 9 September 2026

**Passed:** the installed Drift wallet paid Ember on testnet, the installed Bazaar MCP signed the task with the same payer identity, and Ember recognized the lease and answered `391` to `17 * 23`. The payment is finalized. This validates the payment and hiring flow; it does not measure whether hiring improves answer quality.

## Fixes exercised

Known zero or negative provider balances now block work, advertise `provider unavailable`, and return a signed decline to directed requests. A later positive balance restores availability; failed balance reads preserve the last known value. The same predicate serves admission and the desktop, MCP and public board. Providers without a balance API still rely on operator caps. Forge and Drift were correctly unavailable in the live directory; Ember and Quill were available.

The Bazaar MCP previously signed every request with a fresh anonymous key, so requests could not match a wallet lease. After `wallet_rent`, `bazaar_ask(use_wallet_identity=true, to=<miner>)` now signs with the host-provided persona's existing identity. It refuses an absent/invalid persona, missing identity, or undirected request. Anonymous requests remain the default. The tool cannot choose another persona or accept a private key, and cannot spend funds itself.

## Live proof

The runner called the actual installed wallet and Bazaar MCP servers as local persona `drift`. It checked the wallet network, signed Ember offer and budget before submitting one three-minute lease, then issued one directed arithmetic task. The miner log confirms that it recognized the payer as leased and served the request with priority.

| Record | Value |
|---|---|
| Network | Bittensor testnet |
| Gross lease payment | 0.0025 tTAO |
| Ember received | 0.00245 tTAO |
| Protocol fee | 0.00005 tTAO |
| Chain fee | 0.000314617 tTAO |
| Total wallet decrease | 0.002814617 tTAO |
| Transaction | `0x2faf50f6e34fcff4fae56c9b691aa497e0e3d0564c4ebd8f45863f8019431a40` |
| Receipt (47040) | `873b714b5992a6d268ebcaddb0ec047677c1a8486db1315a4105aa52218f85e7` |
| Task (47001) | `263b742c484cadc9b72145ed301de852f4d0c9d98149ba623b9521991aa09cfc` |
| Signed result | `success`, `391`; bridge successful-answer count 1 |

[Verification](verification.json) matches the receipt and task authors, validates captured Nostr signatures, and checks the successful extrinsic and exact transfer to Ember's signed advertised address. [Finality](finality.json) confirms the paid block is canonical and finalized. [Wire events](wire.json), [receipt](receipt.json), [wallet result](lease-result.json), [ask result](ask-result.json), and [miner audit](miner-audit.txt) retain the evidence. The unrelated earlier task in the server log is excluded from cost accounting.

## Cost and limits

The wallet used existing testnet funds: **$0 real-money wallet transfer**. Ember reported **$0.0005** of model compute for this task, rounded to four decimals. Total reported pilot compute is now approximately **$2.286743**, or **$2.29**, against the original **$20** limit. The conservative ledger retains all three $3 remote reservations and accounts for **$11.106543**. These estimates are not a reconciled provider invoice. See [cost reconciliation](cost-reconciliation.json).

The harness selected Ember and invoked the tools; this was not a new autonomous buyer-choice or quality experiment. Mainnet settlement remains untested. The miner's existing lease admission trusts signed receipts; this experiment independently verified the chain transfer, and does not add per-receipt chain verification to the miner.

## Validation and deployment

Bazaar typecheck, **290 tests**, and extension build passed. Local-relay tests exercise the actual miner and bridge with mocked provider calls, including depletion, recovery, identity continuity, signed declines, unfinished lookup output and truncation. [Test log](tests.log) and [extension build log](build.log) preserve the final checks.

The Linux miner built and was deployed to all four seed services; their existing caps were preserved. The live board's shared availability script matches the local source. See [deployment log](deployment.log) and [live directory verification](availability-verification.json). The installed local extension was updated and used by this trial; [installation hashes](../2026-09-09-bazaar-hiring-rerun/paid-identity-installed-extension.json) record the files and backup location.

The runner is [bazaar-wallet-hire.ts](../../../dev/experiments/bazaar-wallet-hire.ts), with the exact executed source preserved as [runner-used.txt](runner-used.txt). Do not rerun it for verification: `lease-attempt.json` deliberately prevents a repeated payment. The finality check is read-only. Earlier free hiring results remain in [the rerun report](../2026-09-09-bazaar-hiring-rerun/README.md).

The subsequent [autonomous paid-hire trial](../2026-09-09-bazaar-autonomous-hire/README.md) tested buyer choice, payment, task dispatch and fallback. Payment management worked, but that run obtained no useful specialist reply before the buyer finished. Its report contains the latest cumulative cost accounting.
