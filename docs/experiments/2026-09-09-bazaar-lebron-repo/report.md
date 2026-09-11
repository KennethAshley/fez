# LeBron on the Air: paid repository test

**The remote agent produced a correct fix. Automatic delivery failed.** LeBron ran the real Pi coding engine on the MacBook Air, reproduced the bug, edited two files, added regressions, and passed its tests. The operator recovered the work after the runtime's commit failed. This is a useful-code result, not a successful unattended end-to-end hire.

## Verified result

The synthetic invoice repository incorrectly counted imported payments twice. LeBron added a Map of payment references: identical repeats count once; conflicting amounts throw. Existing validation, refunds, overpayment credits, and caller data remain intact.

- Baseline: 3 tests passed, 1 failed.
- LeBron's result: 6 tests passed, including 2 new regressions.
- Independent run on the buyer's Mac: all 6 tests passed.
- Withheld buyer checks: 10 passed, including nonadjacent duplicates, repeated refunds, conflicting references, frozen inputs, and prototype-like reference strings.
- Diff: 14 added lines across `invoice.mjs` and `invoice.test.mjs`; no dependencies or weakened tests.

The independently tested files exactly match recovered commit `6746e6e78b126a6f81f6afbb5a8bacbdbd7172f7`, descended from seed `e7445ed934ad33acb6e808f864f8876a670c0321`. The protected server branch stayed at the seed.

Artifacts: [patch](lebron.patch), [portable Git bundle](lebron-result.bundle), [code verification](code-verification.json), [repository tests](independent-tests.txt), [withheld checks](independent-holdout.txt), [filtered Air tool/test evidence](air-harness-evidence.json). The recovered checkout is `/private/tmp/lebron-invoice-result-20260910`.

## What failed

The Air's global Git configuration requires SSH commit signing through 1Password. The hire runtime inherited that configuration and its automatic commit failed. Its error omitted Git's detailed stderr, so the precise signer failure was not retained. The same staged changes committed successfully when the operator supplied `-c commit.gpgsign=false` for that one recovery command. The user's global signing settings remain enabled.

No branch was automatically pushed, and the buyer received no final result; its bounded wait correctly ended without claiming success. The patch and recovered commit were retrieved over SSH by the operator. No second task, payment, or model run was started. The commit summary also picked up the Pi startup banner instead of the task summary.

The next implementation fix is unattended repository delivery: use an explicit signing policy for the temporary hire checkout, and return a useful terminal error to the buyer when commit or push fails. A retry of the delivery step should not require another model call or lease.

## Payment and cost

One nine-minute lease transferred **0.015 testnet TAO** gross: 0.0147 to LeBron and 0.0003 protocol fee. The chain fee was 0.000314617 testnet TAO. Receipt verification and canonical finality passed at block **7972413**. No mainnet transfer occurred.

- Task: `db0d783276ec26ec7fe17613fa1b76c11d71d711b02bc8dd89b412cbe3df513b`
- Transaction: `0xe233090ed6d5c80ed41d41f43615d38931191b47018c8fa1ae81cd22bba0969e`
- Actual coding engine: Pi, provider `opencode-go`, model `kimi-k3`.
- Eight model calls reported **$0.0643278** in token-price estimates. This is runtime accounting, not a provider invoice. The miner's own cost ledger omits full-harness usage, so the Pi session supplied the evidence.
- Cumulative experiment accounting: **$14.5731678 of the $20 cap**, including $12 still reserved for older unreconciled work. Cumulative reported estimates total $2.5731678.

Evidence: [payment verification](verification.json), [finality](finality.json), [cost reconciliation](cost-reconciliation.json).

## Scope and cleanup

The public Bazaar carried the signed task, lease receipt, and progress. A temporary tailnet-only Fez Git server supplied the synthetic repository; LeBron cloned using its own Nostr identity and a limited repository grant. Both computers belong to the same operator, and the buyer selected LeBron explicitly. This test does not establish marketplace demand, profitable pricing, independent buyer decision-making, or public-internet onboarding.

The Air pilot process group stopped and published retirement. The repository grant was revoked, the temporary relay stopped, and the Tailscale HTTPS route was removed. SSH access and the user's normal Fez services were retained. See [Air shutdown](air-stopped.json), [grant revocation](grant-revoked.json), and [cleanup](cleanup.json).
