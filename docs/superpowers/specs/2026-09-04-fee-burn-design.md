# The Fee Burn — giving alpha a job at the till

*2026-09-04. Stage 5's tokenomic half (the mechanism half — escrow —
shipped). Prompted by the Ditto (SN118) comparison: a live agentic subnet
gave its alpha demand by making it the currency you pay the service with.
fez won't do that (customers stay in TAO/USDC by design), so this is the
behind-the-counter version. Economics spec — decisions are proposals for
argument, not a build order.*

## The problem, stated honestly

Today alpha only flows OUT of the system: the subnet mints it as
emissions, agents stake it, and its price floats on belief. **Nothing we
built puts value INTO alpha from real revenue.** Escrow settles in TAO,
rent ticks are TAO, hires pay in whatever the client holds. So alpha is
pure emissions inflation — miners earn it, sell it for TAO to pay their
inference bills, price drifts down, the dollar value of the $2k/day
emissions drifts down, the bait stops being worth chasing. Emissions
*bootstrap* a market; they cannot *sustain* one. The fee burn is the
conversion step that lets real settlement volume hold alpha's price up.

## Thesis

Skim a small protocol fee off each organic settlement, use it to
**market-buy alpha from the subnet's own AMM pool and burn it.** The
customer never touches alpha (no friction, no "acquire a subnet token
first"); the demand lands behind the till. Two effects, both permanent:
buying alpha with TAO raises its price (pool TAO up, alpha out), and
burning what's bought shrinks supply. Every hire and every rented hour
becomes a small, on-chain, irreversible bid for the token — so alpha's
floor tracks **settlement volume**, not belief.

Ditto puts the demand at the door (pay in alpha); fez puts it at the till
(pay in TAO, burn behind it). Lower friction for the customer, at the
cost of one conversion hop and a fee.

## The mechanism

1. **Skim.** On each settlement, take a small cut in the settlement
   currency before the worker is paid:
   - escrow release: `fee = amount × rate`, worker gets the rest;
   - rent tick: `fee` off each tick;
   - direct hire payment: same.
   Worker/agent receives `(1 − rate)`. The fee accrues to a protocol
   **burn treasury** (a dedicated coldkey, distinct from the guardian
   treasury).
2. **Batch, don't burn per-settlement.** Each buy-and-burn is a chain tx
   with gas; per-tick burning would eat itself. The burn treasury
   accumulates fees and runs the buy-and-burn on a schedule (daily) or a
   threshold (once N tTAO collected).
3. **Buy.** Convert accrued fee-TAO into alpha through the subnet's AMM —
   the same pool the wallet already reads for `alphaPriceTao`
   (SubnetTAO/SubnetAlphaIn). Acquisition primitive: `addStake`
   (TAO→alpha under a hotkey) or the chain's `swap` pallet if a direct
   swap is cleaner. Buying raises the alpha price by construction.
4. **Burn.** Remove the bought alpha from circulation permanently. Open
   implementation question (see Risks) — candidates: stake it to a
   provably-unspendable hotkey (nobody holds the key → never unstakable),
   a governance/burn extrinsic if subtensor exposes one, or a locked
   treasury position. True supply-burn is the strongest narrative; a
   permanent lock is the pragmatic floor.
5. **Publish.** Every buy-and-burn is on-chain; surface it like the
   corpus counter — "N alpha burned from M tTAO of settlement this week."
   The sink must be legible or it's just a claim.

## The loop it closes

more hires/rents → more settlement → more fee-TAO → more alpha
bought-and-burned → alpha price up → emissions (paid in alpha) worth more
→ more agents mine → better corpus & service → more customers. This is
the join where the flywheel stops being a faucet.

## Decisions to pin (proposals)

- **Fee rate: start small, 2–3%.** It's a tax on the exact market you're
  trying to grow; too high and hires route off-platform. Governable.
- **Currency scope v1: TAO settlements only.** Rent ticks and TAO escrow
  skim natively. USDC/x402 settlements defer — burning from them needs a
  USDC→TAO hop (a DEX or a market-maker), a later addition.
- **Who executes: the burn treasury, on a schedule.** Not the guardian
  treasury (which holds agent custody) — a separate, auditable coldkey
  whose only verbs are collect-fee, buy, burn.
- **Bootstrapping (optional): the owner take can prime the pump.** The
  18% owner-take TAO could fund buy-and-burn before organic volume
  exists — but name it honestly: that's *recycling emissions*, not real
  demand. It smooths the cold start; it is not the mechanism working.

## Non-goals (v1)

Customers paying in alpha (Ditto's model — rejected on friction),
USDC-settlement burns (needs a conversion venue), a governance token /
fee-voting, dynamic fee curves, MEV-resistant burn scheduling. And
crucially: this does **not** manufacture demand — it *converts* existing
settlement demand into alpha value. Zero customers → zero burn → alpha
still inflates. The hires still have to happen.

## Gates

- Testnet: a settled escrow release skims the fee to the burn treasury;
  a scheduled job buys alpha from the pool (price ticks up, verified on
  chain) and burns/locks it (supply or circulating-alpha verifiably
  drops); the public counter reflects both.
- The worker's payout is exactly `amount × (1 − rate)`, stated on the
  receipt — the fee is disclosed, never silent.
- With the fee at 0, the whole path is a no-op (kill switch).

## Risks (the honest ones)

- **It's a tax on your own market.** Every basis point of fee is friction
  on adoption. The burn's value has to be believed to be worth the drag,
  and early on it won't be (low volume). Keep it near-zero until volume
  justifies it.
- **Reflexivity / wash-settlement.** Burning pumps alpha, and emissions
  ARE alpha — so a miner could wash-settle (hire itself through sock
  puppets) to pump alpha, then dump emissions. Same defense as the
  reputation wash-trade: weight/measure by counterparty diversity, and
  the fee itself makes wash-trading cost real TAO.
- **No native alpha burn is the load-bearing unknown.** If subtensor has
  no true burn, "burn" is a permanent lock — weaker story, and a locked
  position is a governance liability (who guarantees it stays locked).
  This needs a chain answer before building.
- **Bootstrapping is a mirage if over-used.** Priming with owner-take
  recycles emissions and can look like organic demand on a chart while
  being nothing of the kind. If used, label it in the public counter
  ("X% of burns primed from treasury, not settlement").
