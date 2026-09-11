# Fresh unattended repository hire: passed

LeBron completed a fresh paid repository hire on the MacBook Air without operator recovery. The real engine reproduced the failing test, fixed the code, added regressions, ran the tests, and returned control to Fez. Fez committed and pushed the branch automatically. The installed buyer MCP received LeBron's signed success, and the independently fetched branch passed every check.

## Result

- Task: `f47abf2230b7ca9e91caa6ba9cbf8b30b99bcba30e81f3e55b0a12dd2b3dd86b`
- Signed result: `df50b5e59cfea1cfaf7b732247b023ef6fb5a93e2ad32bb2289231f6671bd58a`
- Branch: `lebron/hire-mtv2vheg`
- Commit: `4bd9e29f32a48f09845b9969cc1aded8c9700687`
- Author: `lebron <lebron@fez>`
- Engine: Pi, provider `opencode-go`, model `kimi-k3` (verified from the fresh session's usage records).
- Duration: **20 seconds from signed task to signed result**; approximately 51 seconds of worker runtime including startup and lease preparation.
- Operator intervention after submission: **none in execution or delivery**. Read-only observation, buyer-side verification, and infrastructure cleanup followed.

The challenge repeated the same known failing invoice baseline in a new repository with a new task and session. Payment references repeated with the same amount must count once; conflicting amounts must throw. This controls task difficulty while testing the repaired delivery path.

## Independent verification

- Baseline: 3 repository tests passed, 1 failed as expected.
- Delivered result: **7 repository tests passed** and **10 withheld buyer checks passed**.
- Two files changed: `invoice.mjs` and `invoice.test.mjs`; 17 insertions and 1 deletion. Three regression tests were added. Original tests were preserved verbatim; no dependencies were added.
- Protected `main` stayed at seed `bf9dcac011c0aeb90cb2549c2efd36bb450f0b2b`. The delivered commit descends directly from that seed.
- The result signature is valid, the signer is LeBron, and its task and payer tags match the paid request.

Evidence: [code verification](code-verification.json), [repository tests](independent-tests.txt), [withheld checks](independent-holdout.txt), [filtered Air engine evidence](air-harness-evidence.json), [buyer result](final-report.json), [signed-event and finality checks](finality.json).

## Payment and budget

One lease paid **0.015 testnet TAO** gross: 0.0147 to LeBron, 0.0003 protocol fee, plus a 0.000314617 testnet TAO chain fee. The transaction is canonical and finalized at block **7972944**. No mainnet transfer occurred.

- Transaction: `0x15b0b6ee2e9753a4f0d436a5b454c23d70889a7ae45066fbcdbe888961466521`
- Model usage: **7 calls, $0.0481656 reported token-price estimate**. This is runtime accounting, not a provider invoice. The miner still reports zero harness cost; the Pi session supplies the model usage evidence.
- Cumulative budget accounting: **$14.6213334 of $20**, retaining all older unreconciled reservations. **$5.3786666 remains unallocated.**
- One payment and one fresh task were submitted. No payment, model, commit, or delivery retry was needed.

Evidence: [payment verification](verification.json), [cost reconciliation](cost-reconciliation.json), [model usage](air-run/usage.json), [original budget ledger](../2026-09-09-bazaar-hiring-rerun/ledger.json).

## Cleanup and limits

The worker stopped automatically after publishing success. The runtime removed its temporary checkout; LeBron's miner lock is gone. Global Git signing remains enabled. The temporary repository grant was revoked, the relay stopped, and the Tailscale route removed. Normal Fez services remain untouched. [Cleanup record](cleanup.json), [worker stop record](air-run/stopped.json).

This demonstrates unattended execution and delivery between two machines. Both machines still belong to the same operator, the operator selected LeBron, repository access used Tailscale, and payment was testnet. It does not yet establish independent marketplace selection, demand, profitability, mainnet settlement, or onboarding between strangers.

One cosmetic issue remains: the returned summary and commit subject use Pi's startup banner (`pi v0.0.0`) instead of the substantive task summary. It did not affect the branch, tests, payment, or signed delivery.

Artifacts: [patch](lebron.patch), [portable Git bundle](delivered-result.bundle), [preregistered success criteria](preregistered.json). Verified checkout: `/private/tmp/lebron-unattended-result-20260910`.
