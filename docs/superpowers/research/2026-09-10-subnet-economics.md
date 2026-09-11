# Subnet emissions, settlement fees, and agent bonds

Research date: 2026-09-10. Primary-source review; no mainnet or testnet state was queried. This note covers external economics. The parallel local audit covers Fez payments, the subnet implementation, and the sibling `fez-bazaar` repository. No implementation changes.

## Decision

Build demand for paid, verifiable agent work before adding financial incentives. Use measured task outcomes for reputation; use a bond to cover exposure to misconduct. Treat useful, consented trajectories as an output of that market and prove that they improve a held-out orchestration benchmark before making dataset production the subnet's sole purpose. These are recommendations, not claims about deployed Fez behavior.

## What a hypothetical $2,000/day means

TAO injected into a subnet pool and alpha paid to participants are different flows. The current official docs describe TAO allocation by moving alpha price, adjusted for withheld miner incentive and an emission gate. The current gate's midpoint defaults to the 32nd-highest adjusted share. Alpha accrues separately; a young subnet can emit up to one participant alpha per block, plus pool alpha. TAO that cannot fit the liquidity-injection cap buys protocol-owned alpha. The system currently emits 0.5 TAO per block network-wide after its December 2025 halving. [Official emissions documentation](https://www.bittensor.com/docs/concepts/emissions)

The July 2026 V440 release introduced the emission gate to reduce rewards to weakly demanded subnets. Its initial description uses a demand quantile; the current docs above describe the later rank-based midpoint. Earlier documentation claiming net-TAO-flow allocation is stale for this analysis. Neither purchasing a slot nor configuring a subnet promises $2,000/day. [V440 release](https://www.bittensor.com/releases/v440-upgrade)

The normal participant-alpha split is 18% owner, 41% miners, and 41% validators/stakers. Therefore, **if $2,000 is the marked value of total participant alpha**, the owner's portion is approximately $360/day before costs, taxes, price movement, or selling slippage. The miners' and validators' shares are not discretionary company revenue. If $2,000 refers to TAO entering the pool, the 18% calculation does not apply to that number. [Protocol participants](https://learnbittensor.org/concepts/protocol-participants)

## The fee arithmetic

Own calculation, ignoring processing costs and slippage:

`daily buyback budget = externally funded settled volume × fee rate × fraction assigned to buybacks`

| Fee rate | External volume needed for $2,000/day if all fees buy alpha |
| --- | ---: |
| 2% | $100,000/day |
| 5% | $40,000/day |
| 10% | $20,000/day |

At 2%, $10,000/day generates only $200/day gross. If half the fees fund operations and half fund buybacks, $2,000/day of buybacks requires $200,000/day volume. Offsetting a hypothetical $360/day owner sale at 2% requires $18,000/day volume when every fee goes to buybacks. These are cash-flow comparisons, not forecasts of token-price behavior.

Separate three objectives:

1. **Operate without subsidy:** net customer revenue covers operating, compute, and expected refund costs.
2. **Absorb selling:** external alpha purchases compete with sellers; actual results depend on liquidity and other flows.
3. **Retire tokens:** a burn removes acquired alpha; compare burned alpha units with newly emitted alpha units to measure supply offset.

Emissions-funded task rebates, trades between controlled agents, and fees paid out of those rebates are not independent demand. Selling emitted alpha to buy it back is circular and loses fees/slippage. Track unique outside buyers, repeat purchase rate, accepted outcomes, net margin, and explicitly separated subsidized volume. Avoid counting internal agent-to-agent transfers repeatedly as new revenue.

## The existing burn direction is conceptually appropriate

The current chain implementation of `add_stake_burn` atomically buys alpha with TAO and calls `do_burn_alpha`; failure rolls back the combined operation. `burn_alpha` removes spendable stake without lowering the issuance tracker. `recycle_alpha` removes stake and lowers that tracker. Passing a null price limit selects ordinary staking instead of its price-limited variant. [Current runtime source](https://www.bittensor.com/code/pallets/subtensor/src/staking/recycle_alpha.rs)

Burned tokens remain counted toward the issuance cap; recycled tokens can be emitted again. Thus a successful `addStakeBurn` permanently retires alpha under these rules. It does **not** burn the TAO used to purchase that alpha, and protocol-owned alpha purchased by chain emissions is not the same as a project-funded burn. [Supply accounting](https://www.bittensor.com/docs/concepts/emissions)

Recommendations: fund operations and an explicit refund reserve first, then allocate a disclosed fraction of genuine net fees to bounded-price alpha purchases/burns. Do not label the entire 2% a sustainability fee if all of it is destroyed and operating expenses still rely on emissions. Do not promise a price floor or a one-for-one reduction in sell pressure.

## Staking: accountability rather than purchased competence

Proposed design: display **earned performance** separately from **available collateral**. Rank task-specific success, dispute outcomes, repeat customers, and budget/latency adherence. A funded bond can permit more concurrent work or a higher maximum outstanding liability; it should not make the agent's answers appear more accurate. Confidence should increase with independent evidence, not simply with stake size.

A customer refund obligation needs assets in the settlement denomination or conservatively valued collateral. Alpha-only collateral has correlated risk: its value can fall precisely when confidence in the subnet falls. Never promise dollar coverage at alpha's spot price without liquidity haircuts and exposure limits. Third-party backing introduces a separate risk-underwriting product; postpone it until provider self-bonds and dispute handling work reliably.

Current Bittensor has an opt-in registration-collateral primitive. It locks part of registration cost as alpha and releases the lock as emission is earned. Blacklisting prevents future rewards and can strand remaining collateral. This is useful anti-abuse infrastructure, but it does not itself transfer compensation to a cheated customer, certify task quality, or replace escrow/dispute design. [Registration collateral](https://www.bittensor.com/docs/guides/mining/collateral)

Token roles should follow actual use: TAO can remain the settlement/entry asset; alpha can represent subnet participation and support bounded service bonds or fee-funded burns. Neither requiring an extra token on every customer purchase nor paying stake yield creates outside demand by itself. Prefer customers choosing the useful service while the settlement mechanism handles the token conversion.

## Trajectories are plausible, but need a demonstrated buyer or measured gain

A June 2026 paper reports post-training a shopping agent on ORO SN15 trajectories. Its authors report 42.7% held-out success against an 18.0% base model, roughly matching a 43.6% synthetic-data SFT baseline; the work filters structural quality and controls evaluation leakage. This is evidence that carefully curated subnet traces can train a model, not that unfiltered chats, ranking alone, or any new trajectory subnet will have commercial demand. Results are the authors' report, not independently reproduced here. [Original paper](https://arxiv.org/abs/2606.10064)

Recommended first economic loop: a buyer posts a bounded task and budget; agents compete to deliver a checkable result; settlement follows acceptance; a small fee funds operation; validators score independently verified task outcomes under fixed budgets; consented traces become training/evaluation data. For an orchestration subnet, measure the orchestrator's choice/delegation/retry performance against a simple baseline on fresh held-out tasks. Rewarding polished traces without demonstrated outcomes invites judge optimization and fabricated activity.

## Bazaar identification

The parent audit identified the likely reference as the sibling Fez Bazaar repository, so external marketplace comparisons were not used to infer Fez functionality. Coinbase's similarly named x402 Bazaar is documented primarily as a discovery catalog with quality/activity fields; those sources do not establish a stake-to-reputation mechanism. [Coinbase search API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/search-resources)

## Limits

All dollar amounts are the user's scenario and arithmetic, not verified emissions or investment projections. Official current documentation and runtime source were inspected, but deployment version, live pool liquidity, actual fee enforcement, and availability of calls on Fez's intended subnet require the separate local/on-chain audit. Documentation has changed materially since early 2026; pin a deployment's runtime before implementing monetary operations.
