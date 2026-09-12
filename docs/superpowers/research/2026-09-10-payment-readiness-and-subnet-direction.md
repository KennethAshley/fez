# Payment readiness and subnet direction

Review date: 2026-09-10. Read-only implementation review of the current Fez working tree and sibling `fez-bazaar`; both contain ongoing work. No deployment, payment, registration, or staking transaction was performed. Recommendations below are proposed changes, not implemented behavior. External economics and primary sources are in [the companion research](2026-09-10-subnet-economics.md).

## Recommendation

Make the subnet reward verified agent work under a fixed budget. Build toward orchestration policies that choose workers, delegate, verify, retry, and stop better than a simple baseline. Keep consented execution traces as a training output, then demonstrate their incremental value on held-out tasks. Do not reward message volume, self-reported spending, or stake as a substitute for task success.

Keep a small settlement fee, but explicitly separate operating revenue, refund/dispute reserves, and any alpha buyback allocation. Agent bonds should increase the amount of customer exposure an agent may accept; earned task performance should determine its competence reputation.

## Payment readiness: demonstrated testnet paths, substantial mainnet gaps

The recorded September 10 unattended hire paid 0.015 testnet TAO, split into 0.0147 to the worker and 0.0003 fee, with independent finality and result verification. It used two machines under the same operator and does not establish independent customers or real-money demand. [Recorded experiment](../../experiments/2026-09-10-bazaar-unattended-hire/report.md)

The wallet explicitly gates rent, direct hire settlement, escrow, staking, and burn writes against mainnet. [Network guard](../../../packages/fez-wallet/src/stake.ts:66)

### 1. Paid priority is not secured by chain verification

`parseTick` checks event kind, miner tag, TAO asset tag, and a numeric amount. It does not require a transaction hash, chain, network, lease memo, finalized transfer, matching destination, or evidence that the sender paid. `applyTick` grants the claimed time. The miner subscription calls these functions directly. A valid Nostr signature authenticates a claim but does not prove payment. The comment explicitly acknowledges deferred chain verification. [Parser and ledger](/Users/ken/Projects/Fez/fez-bazaar/src/miner/lease.ts:28), [subscription](/Users/ken/Projects/Fez/fez-bazaar/src/miner/main.ts:614)

An offline probe generated a correctly signed receipt with no transaction/chain/network fields and confirmed that it receives one hour of priority. No event was published and no money moved. There is no verified transaction identity deduplication in this path; distinct receipts can claim the same payment. Reapplying the identical tick directly adds another hour. Transport-level event deduplication cannot substitute for transaction deduplication, and the lease ledger survives reconnects while subscriptions replay history.

Required before real-money use: bind a receipt to a finalized transfer, payer identity, agreed payee/rate/network, and uniquely consumed transaction output/event. Persist credited payments and reconstruct time deterministically across reconnects and restarts.

### 2. Rental duration and recovery do not match the customer-facing promise

The renter calculates gross payment as `hours × rate`, subtracts the fee, and publishes the worker's net receipt. The worker divides that net amount by the unchanged hourly rate. With the fee enabled, paying for 60 minutes credits 58.8 minutes, although the CLI/MCP report the original requested hours. The offline probe reproduced this exact result. [Renter](../../../packages/fez-wallet/src/rent.ts:111), [worker metering](/Users/ken/Projects/Fez/fez-bazaar/src/miner/lease.ts:42)

A rental can also finalize on chain and then throw if receipt publication fails. It has no durable paid-but-uncredited recovery record in this path; blindly retrying repeats the transfer. Direct settlement treats receipt publication as best-effort, but that alone does not give rentals recoverable delivery. [Publication after payment](../../../packages/fez-wallet/src/rent.ts:171)

Rent is prepaid time in discrete chunks, with up to 24 hours allowed in one call. Exposure is the entire prepaid chunk. It does not implement continuous second-by-second settlement, service guarantees, or automatic refunds for unused time. Lease priority still respects the provider's spend cap, so payment cannot guarantee capacity. [Wallet rent tool](../../../packages/fez-wallet/src/mcp.ts:262), [lease tests](/Users/ken/Projects/Fez/fez-bazaar/test/lease.test.ts)

### 3. Escrow is a native multisig primitive, not a complete per-job settlement system

The 2-of-3 account and exact-call approval design are useful: no single participant can move funds, and the fee-bearing payout uses an atomic batch. Refunds do not charge the settlement fee. However:

- Every job involving the same three participants derives the same address. There is no job nonce in address derivation; concurrent jobs pool their balances and can share pending call hashes.
- Both approvals independently compute the fee using local wallet configuration. Different fee-vault availability or addresses generate different call hashes and prevent the intended approvals from combining. The source notes that both approvals currently run on one machine.
- There is no agreed, signed per-job contract binding task, amount, fee destination, acceptance criteria, and deadline in this escrow API.
- No automatic timeout refund or arbitration service is implemented here. If a needed counterparty and arbiter disappear, funds can remain stuck. Any two signers can also collude; a multisig is not proof of delivery quality.
- Status reports account balance, not a job-specific state machine. Execution checks a balance decrease rather than decoding the exact successful inner transfer at the finalized block.

[Escrow address and release](../../../packages/fez-wallet/src/chains/escrow.ts:44), [fee computation and status](../../../packages/fez-wallet/src/stake.ts:205)

### 4. Fee collection is local and the fee funds burns, not operations

The fee is 2%, enabled only when `requirePersonaPair("burnvault")` succeeds on the payer's machine. This is not a network-wide public fee-recipient setting. Without that local wallet entry, the fee is zero; therefore aggregate protocol settlement volume cannot be assumed to generate 2% revenue. Never distribute the vault's signing key merely to make client fee derivation work. [Fee configuration](../../../packages/fez-wallet/src/fees.ts:26)

Every collected fee is earmarked for the burn vault, with no operating or reserve split. The burn runner is reachable from the CLI; no scheduler invoking it was found in the wallet source. Its current call supplies no price limit. Verify scheduling, bounded execution prices, custody, and public reconciliation before treating this as an operating economic loop. [Burn runner](../../../packages/fez-wallet/src/fees.ts:114), [CLI](../../../packages/fez-wallet/src/cli.ts:165)

Current Bittensor source supports an atomic TAO purchase followed by permanent alpha retirement. That destroys alpha, not the purchasing TAO. A buy does not establish a price floor. [Runtime source](https://www.bittensor.com/code/pallets/subtensor/src/staking/recycle_alpha.rs)

### 5. The renter also trusts raw relay offers

`marketQuery` accepts raw WebSocket events, and `offerFromAnnounces` uses their contents without locally verifying signatures, the requested author, or kind. A dishonest relay can therefore substitute a pay-to address despite the filter sent in the request. This is separate from the worker's receipt-verification gap. Signed offers must be verified locally before funds are sent. [Offer path](../../../packages/fez-wallet/src/rent.ts:38)

## What Bazaar staking actually does

The newcomer earnings ramp lasts 14 days. Ten alpha behind a hotkey supplies up to 0.5 ramp credit; a brand-new identity can thus start at half its un-ramped score for emission weighting, and reach full weight after seven days. With no stake, it reaches full weight at fourteen days. Grades are published before this adjustment, so stake does not improve the underlying quality grade. Seed agents are exempt. [Ramp](/Users/ken/Projects/Fez/fez-bazaar/src/validator/metagraph.ts:26), [integration](/Users/ken/Projects/Fez/fez-bazaar/src/validator/main.ts:267)

The chain read is `TotalHotkeyAlpha`: it is aggregate backing, not independently proven self-earned or locked stake. The wallet exposes unstaking; the ramp adds no per-job lock, slashing, or customer-compensation mechanism. After the time ramp completes, stake provides no additional ramp benefit. Calling this permanently locked collateral or durable reputation overstates the implementation. [Chain read](/Users/ken/Projects/Fez/fez-bazaar/sidecar/set_weights.py:60), [unstake](../../../packages/fez-wallet/src/stake.ts:96)

Prefer two separate displays: task-specific performance with evidence and uncertainty, and collateral actually available for outstanding obligations. Use collateral for concurrency/maximum-job exposure, with explicit dispute and release rules. Alpha-denominated operator bonds can create useful demand, but customer refunds need reserves in the settlement currency or conservative collateral valuation. Third-party agent backing can wait until provider bonds and dispute recovery are proven.

## Economics: three separate measurements

1. Operating sustainability: outside customer revenue minus actual delivery, verification, support, and expected refund costs.
2. Market purchases: outside-funded fees allocated to alpha purchases, compared with observed selling; do not assume all emissions sell immediately or purchases guarantee price support.
3. Supply retirement: alpha units burned divided by alpha units emitted, with participant and pool issuance identified separately.

At 2%, $100,000/day externally funded settled volume produces $2,000/day gross fees. If half goes to operations/reserves, $200,000/day is needed for $2,000/day of buybacks. At 5%, allocating every fee to buybacks needs $40,000/day. These are arithmetic scenarios, not liquidity or revenue forecasts.

If $2,000/day means the market value of participant alpha, the standard 18% owner allocation is roughly $360/day before costs and execution losses. If it means TAO injected into the pool, this split cannot be applied to that number. If it means owner proceeds, the full $2,000 is the relevant gross owner budget. Slot ownership alone guarantees none of those amounts. [Current emissions and distribution](https://www.bittensor.com/docs/concepts/emissions)

Separate outside purchases from treasury-funded experiments and rebates. Count a customer's money once across a chain of agent subcontracts when measuring demand. Buying alpha with proceeds from selling emitted alpha recycles the subsidy; it does not create outside revenue. Recurring operating costs should be supportable even if emissions' dollar value falls.

## A narrower subnet objective

Current Bazaar uses `research-citations/v2`, with 70% pairwise quality, 20% conduct, and 10% timeliness. This is a useful grading prototype; relative wins do not alone establish an absolute success threshold or commercially useful orchestration. [Judge](/Users/ken/Projects/Fez/fez-bazaar/src/validator/judge.ts:13)

The corpus exports one worker's signed progress/results against a hash, with grades and deliverable. Directed hires are deliberately excluded. It is not a complete trace of an orchestrator selecting workers, paying them, evaluating their results, retrying, and deciding to stop. Preserve the privacy boundary: richer public benchmark traces or explicit data consent are needed, not automatic export of customer work. [Exporter](/Users/ken/Projects/Fez/fez-bazaar/src/corpus/export.ts:92), [row shape](/Users/ken/Projects/Fez/fez-bazaar/src/corpus/build.ts:142)

Recommended first vertical: repository bug fixes with protected tests, withheld buyer checks, clear delivery, and a fixed budget. Existing Fez experiments already exercise this shape, so it needs less speculative infrastructure than a global general-purpose orchestration corpus.

For the subnet, miners should provide executable agent/orchestration policies that validators can run under controlled budgets. Score verified completion and cost/latency within a task class; include the ability to solve directly without delegation. The owner should not centrally choose miner payouts outside the validator mechanism. Avoid reward formulas proportional to money spent, message count, synthetic hires, or claimed revenues: these invite subsidy farming.

For training, record routing decisions, tool/worker calls, verified costs, outcomes, retries, and stop decisions in consented benchmark runs. Evaluate the learned policy against a competent single-agent and simple-routing baseline on unseen tasks, with separated task families and frozen acceptance checks. Demonstrating better measured outcomes is the gate for a fine-tune; a larger JSONL file is not.

Proposed pilot: ten bounded tasks from independent prospective buyers, with a paid price, fixed budget, and acceptance test recorded before execution. Benchmark direct execution and delegation on the same held-out task distribution, measure total cost including verification, successful delivery, elapsed time, operator interventions, and willingness to repurchase. This establishes feasibility and demand signals; ten tasks are not sufficient evidence for broad performance claims. Expand before claiming a general advantage.

## Fresh validation

- Root `npx tsc --noEmit`: exit 0.
- Wallet suite: 360 passed, 0 failed.
- Bazaar suite: 301 passed, 0 failed.
- Full Fez evals: 1,483 passed, 1 failed, 1 skipped. The failure was `browser-wire-relays.test.ts` / “publishes fan out to every relay.” Its isolated rerun passed all nine tests. This does not make the full run clean.
- Offline probes confirmed: correctly signed but unpaid receipt accepted; repeat application adds time; 2% fee reduces one requested hour to 58.8 credited minutes; stake changes ramp as described.

Initial sandbox runs could not open local test servers; the reported suite results are reruns with local networking allowed. Existing tests do not cover all payment guarantees identified above, so passing wallet/Bazaar suites does not establish mainnet readiness. No fixes were applied during this review.
