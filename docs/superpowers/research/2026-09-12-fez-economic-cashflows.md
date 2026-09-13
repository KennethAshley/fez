# Fez economic cashflows: wallet and mining source assessment

Assessed 2026-09-12. Source inspection only: no transactions, live balances, deployment checks, or tests. “Implemented” below means present in the current checkout, not proven deployed or commercially active. Bazaar ranking is assessed separately.

## Conclusion

Fez already implements mechanisms for agents to earn, pay other agents, retain earned alpha, and convert selected settlement fees into alpha burns. This is meaningful infrastructure for an agent economy. It does **not**, in these paths, implement a general company revenue share or establish that user/miner earnings exceed their compute costs. Ecosystem activity, token demand, and cash available to operate Fez are different quantities.

## Implemented money paths

| Path | Recipient and enforcement | Business interpretation |
|---|---|---|
| Flat hire payment | Persona pays recipient 98%, local burn vault 2%, atomically when a vault exists; otherwise recipient gets 100%. | Paid agent service works in source; the fee funds burning, not company operations. |
| Hourly rental | Same atomic split. Signed receipt reports net payment; `paidHours` is reduced proportionally by the fee. | Rental is prepaid service access. Gross customer spend differs from provider receipts and service time. |
| Escrow release/refund | 2-of-3 multisig release can split worker/vault; refund returns the amount without a fee. | Chain enforces the approved transfer, not the quality judgment. Parties decide release/refund. |
| Burn | Locally controlled burn-vault persona calls `addStakeBurn` for the selected subnet, retaining a gas buffer by default. | A use for collected fees, with no automatic cash margin for Fez. Code comments predicting price support are economic hypotheses, not guarantees. |
| Agent self-stake | Persona signs staking to its own hotkey; unstake can reverse it subject to chain rules. | Agent-held capital stays economically distinct from service income and operating cash. |
| Emission payout | Guardian treasury transfers earned alpha to the agent's coldkey on the same hotkey; it remains staked. | “Treasury” means the wallet owner's treasury, not necessarily Fez company's treasury. No fee is taken here. |

Sources: [fee split](../../../packages/fez-wallet/src/fees.ts), [flat payment](../../../packages/fez-wallet/src/rent.ts), [rental transfer and net receipt](../../../packages/fez-wallet/src/rent.ts), [paid hours](../../../packages/fez-wallet/src/rent.ts), [escrow approvals](../../../packages/fez-wallet/src/stake.ts), [burn operation](../../../packages/fez-wallet/src/fees.ts), [self-stake](../../../packages/fez-wallet/src/stake.ts), [payout](../../../packages/fez-wallet/src/cli-commands.ts).

## Fee scope and company capture

The 2% rate is a local constant. Its recipient is `requirePersonaPair("burnvault").address`; there is no fixed global company recipient. A missing local vault turns the fee off. The split is implemented in the sender's client, not imposed on every protocol participant or every payment rail. This is an optional burn contribution in the current implementation, not a guaranteed protocol-wide commercial take rate.

Generic `walletSend` transfers the full requested amount through the adapter after balance/consent checks, without `splitFee`. The x402 path signs the service's requested USDC payment to its `payTo`, also without the burn split. Consequently, neither total wallet volume nor total Fez activity is an appropriate denominator for expected burn revenue. Sources: [local vault kill switch](../../../packages/fez-wallet/src/fees.ts), [generic send](../../../packages/fez-wallet/src/tools.ts), [direct transfer](../../../packages/fez-wallet/src/tools.ts), [x402 payment destination](../../../packages/fez-wallet/src/x402.ts).

Escrow fee terms also depend on the local split function used to construct the approved multisig call. The source notes that both approvals currently run on one machine; consistent fee terms across independent parties cannot be inferred from this local configuration. [Escrow call construction](../../../packages/fez-wallet/src/chains/escrow.ts).

## Backing rights and retained earnings

The wallet implements self-staking and explicitly retained agent earnings. Its self-stake display says other accounts' stake is excluded. Bazaar separately reads total alpha behind the hotkey, so the wallet's displayed self stake is not necessarily the same number used by Bazaar's progression mechanism. [Wallet display](../../../packages/fez-wallet/src/gui-reputation.tsx), [Bazaar chain resolution](https://github.com/KennethAshley/fez-bazaar/blob/2dfc6ad1e65e51c1997e8490ff832af74160c027/src/validator/chain-bittensor.ts).

No separate contract granting third-party backers a share of an agent's paid service receipts, guaranteed jobs, or quality-failure slashing was identified in these wallet/mining paths. Those rights must not be inferred from a stake balance or from Bazaar reading that balance. The current chain-level rights of a third-party staker require separate verification against the active network rules.

## Mainnet scope

Self-stake, unstake, registration, emission payout, rental, flat hire payments, escrow, and burn call `requireRehearsalNetwork`, which requires both the test network and its standard endpoint. These are not a mainnet commercial marketplace as currently coded. [Shared guard](../../../packages/fez-wallet/src/stake.ts), [registration](../../../packages/fez-wallet/src/cli-commands.ts).

This does **not** mean all wallet writes are blocked on mainnet. Generic `walletSend` and treasury funding use their configured adapters without that rehearsal guard. x402 defaults to Base Sepolia but explicitly supports opt-in Base mainnet, with separate consent/cap controls. [Treasury funding](../../../packages/fez-wallet/src/cli-commands.ts), [x402 networks and defaults](../../../packages/fez-wallet/src/config.ts), [x402 consent](../../../packages/fez-wallet/src/tools.ts).

## Mining economics

Mining provisions operator-funded infrastructure and uses the persona's hotkey. Lium provisioning selects a node within a price ceiling, runs the provider's CLI, and records hourly cost/TTL; the miner runner supplies the actual persona/hotkey to the subnet extension. No Fez platform commission or automatic sweep of operator mining revenue was identified in these execution paths. [Provisioning](../../../packages/fez-mining/src/machine-lium.ts), [cost ledger](../../../packages/fez-mining/src/machine-lium.ts), [miner identity](../../../packages/fez-mining/src/run.ts), [runtime context](../../../packages/fez-mining/src/run.ts).

Thus mining can make the app valuable to its operators and may fund the operator's agents. It does not automatically make Fez company profitable. Whether Fez owns relevant reward-bearing positions, receives emissions, or has profitable production miners is unverified by this source review.

## What closes the economic loop

1. **Outside demand:** independent customers pay for useful results. Treasury-funded tasks and sponsored evaluations must remain separate from outside sales.
2. **Positive delivery margin:** service receipts exceed inference, infrastructure, failure, support, and human intervention costs. Reusing retained emissions to buy services is spending a subsidy, not creating additional outside revenue.
3. **Explicit company capture:** owned service margins, paid operations, or actual company-owned emissions can pay Fez expenses. The present burn fee is not that capture mechanism.
4. **Measured token use:** track eligible settled volume, enabled-vault volume, accrued fees, executed burns, and actual burned alpha separately. At 2%, 100 units of eligible gross settlement produce at most 2 units of fee asset before operational constraints; no price outcome follows mechanically.

This architecture can support a useful open product and an economy around it. The unproven step is commercial and operational: real outside demand, repeat use, profitable fulfillment, and a defined share that reaches whoever pays to maintain Fez.
