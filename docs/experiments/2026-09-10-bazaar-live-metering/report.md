# Live hire metering: passed

LeBron completed one repository hire on the MacBook Air in 23 seconds. Its
updated worker automatically committed and pushed the fix. Pi reported
**$0.0556305 across seven calls**, and Bazaar persisted **the same amount**.
The spending reservation returned to zero and the pending-hire flag cleared.
No execution or delivery recovery was needed, and the emergency guard never
intervened in the hire.

## Delivered work

- Task: `d63199925c88d67c76e6639c5fdea4772a93aba6664c6b2f8ebf459e64f20858`
- Signed result: `6bb4de3f78eb7e1351f33d5813ae558a91177af5f988fc099e3af3c4734384e6`
- Branch: `lebron/hire-mtv6h57l`
- Commit: `b6db6e87a6d37302dbf2995f5214b179b46ed1a2`
- Engine: Pi, `opencode-go/kimi-k3`.
- Baseline: three tests passed, one duplicate-payment test failed.
- Delivered code: **seven repository tests and ten independent buyer checks passed**.
- Only `invoice.mjs` and `invoice.test.mjs` changed. Original tests were
  preserved, no dependencies were added, and protected `main` stayed unchanged.

The task repeated the earlier synthetic invoice problem in a fresh repository
and session. Equal repeated payment references count once; conflicting amounts
throw. This holds task difficulty constant while testing the new metering path.

Evidence: [code verification](code-verification.json), [repository tests](independent-tests.txt),
[buyer checks](independent-holdout.txt), [patch](lebron.patch),
[portable Git bundle](delivered-result.bundle), [signed result and finality](finality.json).

## Cost and payment

The Air ledger rose from $0.047253 to $0.1028835: **$0.0556305**, matching the
fresh Pi session totals. An intermediate observation also matched at
$0.0126978 while the task was still pending. Final `reservedUsd` was zero and
`pendingHire` was false. Costs are engine-reported price estimates, not provider
invoices.

One lease paid **0.015 testnet TAO** gross. The transaction finalized in the
canonical chain at block **7973448**. No mainnet payment occurred.

- Transaction: `0x20696ddba5e2e92ad2db3c86dc5637e9d050a38243377887e958b4f0053dba00`
- Pilot accounting: **$14.6919399 of $20**, retaining older unreconciled reservations.
- Remaining unallocated budget: **$5.3080601**.
- Separately reconciled: $0.014976 for the background answer after LeBron was
  started and before this test. It is not charged to this hire.

Evidence: [cost reconciliation](cost-reconciliation.json), [native usage and miner state](air-run/usage.json),
[starting state](air-run/baseline.json), [payment verification](verification.json),
[pilot ledger](../2026-09-09-bazaar-hiring-rerun/ledger.json).

## Cleanup and limits

The guard stopped the miner after signed success and final usage had arrived;
no active hire process needed stopping. The temporary checkout was removed,
the Git grant revoked, the test relay stopped, and its Tailscale route removed.
The updated worker remains installed. LeBron's miner is stopped to prevent
additional test spending. Normal standing agents and the desktop app were left running.

This verifies native cost propagation into Bazaar's persisted ledger. The
preregistered wording about a "signed task cost" was not evaluable: task-result
events carry delivery information, and this GUI-launched miner had the optional
owner-metrics environment settings unset. No signed per-task cost record or
desktop Costs-pane behavior is claimed; task/result signatures were checked
separately from usage. The known cosmetic commit-summary issue also remains:
the adapter startup text produced the subject `## Extensions`.

Both machines belong to the same operator, repository access used Tailscale,
and payment used testnet. This does not test onboarding or commerce between
independent operators.

Evidence: [guard completion](air-run/stopped.json), [Air cleanup](air-run/cleanup.json),
[grant revocation](grant-revoked.json), [overall cleanup](cleanup.json).
