# Fez and Bazaar: existing economic loop assessment

Assessed 2026-09-12 against local working trees: Fez HEAD `7a2ffe0`, Bazaar HEAD `c87d3ca`. Bazaar has uncommitted changes, including coordination and directory changes; these findings describe inspected working files, not just those commits. No live balances, deployment versions, paying-customer cohorts, or profitability were verified. No monetary actions or product changes were made.

## Judgment

Fez already has meaningful economic infrastructure. Its strongest business thesis is an open workspace connected to a market of identifiable agents with observable work histories, hiring paths, and subnet incentives. It does not need to become a bespoke-services agency to pursue this thesis.

The current components form partial loops, not a demonstrated self-sustaining economy. In particular, backing affects a temporary research-reward multiplier; quality records inform discovery; customer payments compensate providers; optional fees fund a burn vault. These should not be collapsed into an automatic chain of backing → reputation → better jobs → company profit.

## Backing has real but bounded utility

[The age ramp](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/src/validator/metagraph.ts) uses these defaults for enrolled, non-seed research miners:

`multiplier = min(1, ageDays / 14 + 0.5 × min(1, alphaBehindHotkey / 10))`

| Age | No alpha | 10 test alpha |
| --- | ---: | ---: |
| Day 0 | 0 | 0.5 |
| Day 7 | 0.5 | 1 |
| Day 14 onward | 1 | 1 |

These are score multipliers used before weight normalization, not guaranteed fractions of income. [Weight normalization](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/src/validator/weights.ts) makes shares relative to other eligible miners. Equal positive multipliers across all miners cancel out. The chain's eventual allocation is separate from one validator's declared vector.

[The validator](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/src/validator/main.ts) obtains registered identities and hotkey alpha through [the chain sidecar](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/sidecar/set_weights.py). It publishes grades before applying the ramp. The backing input is aggregate hotkey alpha, not an evaluation of individual backers' credibility. Seed miners bypass the ramp.

Economic implication: retaining or adding alpha can improve a newcomer's relative reward opportunity. The mechanism saturates at 10 test alpha and loses its incremental benefit by day 14. It creates an onboarding incentive, not an unlimited or permanent reason to accumulate alpha. It does not distinguish fresh outside backing from already-earned alpha, and this path does not create a contractual share of customer earnings for backers.

## Reputation can help hiring, but backing does not automatically raise reputation

[Bazaar rows](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/src/gui/logic.ts) sort by average trusted historical research score. Versioned coordination outcomes are separate. [The agent-facing directory](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/src/bridge/directory.ts) carries descriptions, availability, rates, scores, outcomes and receipt claims; it has no stake-ranking field. A human or model can select using the evidence, but there is no implemented guarantee of higher-value jobs for a more-backed agent in this path.

[SALT](../../../packages/fez-client/src/salt.ts) separately derives viewer-relative trust from signed accepted-work notes and vouches. It excludes the agent, known owners and siblings. This is useful customer context, but hidden related identities remain possible; signatures do not establish independent buyers. Positive evidence also does not supply the denominator of failed hires.

The directory explicitly emits `paymentsVerified: false`. Its `paidHires` count is distinct receipt-issuing pubkeys, not verified settled jobs or distinct economic owners. [MCP instructions](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/src/bridge/mcp.ts) still call this a count of paying clients and recommend using it for selection. That wording is stronger than the underlying evidence and should be corrected before treating these counts as commercial traction.

## Two earning paths already exist in the architecture

The [research validator](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/src/validator/main.ts) translates scored work into a chain-weight submission path. [The current coordination lane](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/README.md) explicitly does not submit rewards, while independently authorized specialists can be paid for services. The README describes testnet 553; deployment and chain credit were not checked here.

[Market discovery and hire proposals](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/src/bridge/mcp.ts) already connect browsing to directed asks, paid leases and escrow proposals. Those are useful foundations for converting visible capability into paid work. The commercial bridge still needs observed accepted, settled, repeat customer jobs. Benchmark rewards alone do not demonstrate that bridge.

## Company sustainability and token utility are different outcomes

See [the independent cashflow trace](2026-09-12-fez-economic-cashflows.md) for current source references. The inspected wallet charges an optional 2% fee on selected settlement paths only when a local burn vault exists. That fee goes to the vault, not an operating account. Generic sends and other rails are not automatically covered. Mining infrastructure and provider costs belong to the operator; no universal platform share was established.

Thus an agent earning more, alpha having useful demand, and the Fez company receiving spendable margin are three separate results. A healthy market could support optional managed infrastructure and disclosed service fees without restricting the open app. Those are business choices, not revenues demonstrated by this audit.

Under the [currently documented emission rules](https://www.bittensor.com/docs/concepts/emissions), the standard owner allocation is 18% of participant alpha, not all subnet rewards or pool TAO. That may fund development but is variable token income. [Native delegation](https://learnbittensor.org/concepts/tokenomics/staking-and-delegation) shares validator dividends; it does not by itself entitle a backer to a miner's service revenue. Neither staked balances nor marked token prices should be counted as company cash.

## Highest-value next evidence

Trace one existing Bazaar cohort from discovery → selection → agreed price → accepted result → verified settlement → repeat hire. Record why each agent was selected, its backing, task-specific record, total delivery cost including human rescue, and the fee recipient. Keep research subsidies and related-party jobs separately identified. Consent is required before exporting private customer material.

This tests the existing product rather than creating an agency or a new staking product. It can establish whether visible history helps matching, whether suppliers earn contribution margin, and whether Fez can capture enough revenue to operate. Repeated observations are needed before claiming backing causes better jobs.

If that bridge works, evaluate durable alpha utility tied to real obligations or capacity. Do not increase stake-based ranking merely to manufacture holding demand: that would favor capital independently of customer outcomes.

## Verification

Ran `bun test test/metagraph.test.ts test/directory.test.ts test/weights.test.ts` in the Bazaar checkout: **28 passed, 0 failed, 89 assertions**. These exercise local ramp, directory and weighting behavior, not live economics. No full application verification was needed for this research-only change.
