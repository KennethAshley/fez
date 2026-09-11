# Autonomous paid-hire trial — 9 September 2026

**Payment management passed; useful paid assistance failed in this run.** The buyer selected Quill, paid with its testnet wallet, and signed its task with the same identity as the lease receipt. It chose a 60-second response deadline, received no answer in time, and finished independently. Quill eventually published a signed, truncated failure after 103 seconds. The buyer did not use specialist work or hire a second specialist.

[Bazaar PR #1](https://github.com/KennethAshley/fez-bazaar/pull/1) was merged at `5cf05ad442557d03c379b278f83b7a872c279f7c`. The merged tree exactly matches the tested head. Typecheck, **290 Bazaar tests**, and the extension build passed before merging. Fez typecheck and **1,418 tests with one skipped** passed for the experiment workspace. See [merge evidence](merge.json), [Bazaar tests](premerge-tests.log), [build](premerge-build.log), and [Fez gate](fez-evals.log).

## What the buyer decided

The model, `claude-haiku-4-5`, received the frozen private-workspace task and primary sources from the earlier pilot. It chose JSON actions that the experiment runner dispatched to the actual installed wallet and Bazaar MCP servers. The harness constrained the budget, testnet network, payment bounds and permitted tools; it did not choose the miner, duration, question, timeout or final answer. No human steering was supplied during execution.

1. Read the live market directory.
2. Checked its wallet balance.
3. Chose Quill based on availability, judged record and its writing/research description. Rented 0.08 hours at 0.25 tTAO/hour: **0.02 tTAO gross**.
4. Wrote a public privacy/access-control review request and called `bazaar_ask` with `use_wallet_identity=true` and a **60-second** wait.
5. After timeout, chose to finish independently. Its `hireAssessment` accurately disclosed that it received no specialist answer.

The model had permission and budget for one more distinct hire but chose not to use it. This demonstrates honest fallback to unaided work, not recovery that obtains useful specialist work. The fallback answer was 402 words despite both the prompt and the buyer's own claim that it met the 300-word limit.

The [action history](history.json), [installed tool definitions](tools.json), [full prompts and responses](buyer-0.json), and [run log](run.log) preserve the sequence. The remaining buyer calls are numbered 1–4 in this folder.

## Comparison

Both arms used the same buyer model, task and frozen source packet. The solo arm made a new draft and one revision. The paid arm used five buyer calls for shopping, payment, task dispatch and synthesis. Two blind judgments used `claude-sonnet-5` with reversed display order and the original five-criterion rubric. Both raw judgments parsed; the second put B's explanation in a separate `reason_b` field, which is preserved without repair.

| Measure | Solo | Paid-hiring attempt |
|---|---:|---:|
| Blind score, first display order | 9/10 | 7/10 |
| Blind score, reversed display order | 10/10 | 7/10 |
| Wall time to final answer | 19.3 seconds | 103.2 seconds |
| Final words | 294 | 402 |
| Buyer + specialist compute, estimated USD | $0.040374 | $0.229296 |
| Specialist answers used | — | 0 |

See [scores and explanations](scores.json), [solo final](solo-arm.json), and [paid-arm final](paid-final.json). The paid-arm cost includes Quill's late failed generation because the request still consumed compute after the buyer stopped waiting. Judges are excluded from the arm costs and included in the total experiment cost below.

My review agrees that the paid-arm answer is weaker: it fails to specify agent authorization against the authenticated sender for both channels and DMs, invents unsupported roster-list semantics, and suggests deriving a channel encryption key from the member list without a secret. That derivation would not provide confidentiality when the list is public. The solo answer is also not ready to implement: it overstates metadata privacy and conflates relay access policy with possession of decryption keys. The judge's 10/10 should not be treated as a security approval.

This is one descriptive sample with different call counts and possible specialist web access. It cannot establish a general quality effect. In particular, the paid arm received no specialist content, so its score cannot be attributed to specialist advice.

## Payment and late-result evidence

The signed receipt, on-chain successful extrinsic, exact transfer to Quill's advertised address, canonical finalized block, and matching payer/task identity all verified. The server independently logged the payer's lease and priority handling before claiming the task.

| Record | Value |
|---|---|
| Network | Bittensor testnet |
| Gross paid | 0.02 tTAO |
| Quill received | 0.0196 tTAO |
| Protocol fee | 0.0004 tTAO |
| Chain fee | 0.000314617 tTAO |
| Transaction | `0xa3db1a7b5c4c83df10425ae45f95b64f40527e5d171d789748ec767066133508` |
| Receipt | `b4e13b60255d08833e99485deded98e02883ad8c10bdce3a549343cbcd7b1a24` |
| Task | `bc1c5dd3618c2a8fd6117a5f04c38f10cfcefd3ac0d88a4ac0bd513ad8066830` |
| Terminal specialist result | Signed `failure`, truncated output, 103 seconds after task publication |

[Chain verification](verification.json), [signed wire events](wire.json), [late reply](late-reply.json), and [miner audit](miner-audit.txt) preserve the proof. The late reply was fetched read-only after the trial; it was never inserted into the buyer's conversation. Unrelated background tasks in the server log are excluded from cost accounting. No payment or remote request was retried.

## Cost and next finding

This trial used **about $0.484008** of configured-price compute: buyer $0.102596, solo $0.040374, blind judges $0.214338, and Quill's rounded miner-side cost $0.1267. Cumulative reported pilot compute is now **about $2.770751 of $20**. Real-money wallet transfers remain **$0**; the wallet used existing testnet funds.

The conservative ledger still holds all four $3 remote reservations and accounts for **$14.463851** cumulatively; this trial accounts for $3.357308 of its $7 allowance. These are estimates, not a reconciled provider invoice. [Cost reconciliation](cost-reconciliation.json) and [ledger snapshot](ledger-snapshot.json) retain both views.

The concrete product gap is task progress and recovery. Quill sent a signed claim, but the ask bridge only collects terminal results, so the buyer saw a generic timeout while its paid task was running. Waiting longer alone would not have fixed this attempt: the eventual result was a failure. Before another paid trial, expose the existing task's claimed/terminal state and support checking it again; the buyer can then decide whether a shorter follow-up or another specialist is justified.

Follow-up: [task progress and read-only resumption are now merged and verified](../2026-09-09-bazaar-progress-recovery/README.md). A buyer continuation retrieved this trial's late failure without new work or payment. That report contains the latest cumulative cost; its recovery reasoning still needs improvement.

The experiment is a constrained external harness using real installed tools, not a new autonomous-agent feature shipped in Fez. It does not validate mainnet settlement, an independently operated market, or miner-side on-chain verification of every receipt.

## Reproduction boundaries

[Preregistration](preregistered.json) and [frozen sources](sources.json) were saved before model calls. The [executed runner](runner-used.txt) is retained unchanged. It refuses a repeated `run` once `run-start.json` exists and reserves money before each call. Its self-check covers payment bounds, unavailable miners, duplicate attempts, and cumulative/trial budgets. Do not replay payments to verify the result. The separate `verify` mode and [late-result query](late-query-used.txt) are read-only.
