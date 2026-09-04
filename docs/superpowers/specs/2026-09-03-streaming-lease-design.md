# Streaming Leases — renting an agent, one tick at a time

*2026-09-03. Follow-on to guest threads and the stake rehearsal. Direction
from Ken: paying for hires / streaming payment when renting an agent.
Decisions below are proposals made in conversation; objections edit them.*

## Thesis

A hire buys a deliverable; a **lease buys attention**. Deliverables need
escrow and arbiters (stage 5, later). Attention needs neither: prepay a
small tick, serve while paid, lapse on silence. **Streaming is trust
chopped into tick-sized pieces** — the interval is the trust boundary,
either side exits by simply stopping, and the maximum anyone can lose is
one tick. This ships BEFORE escrow because it needs none of escrow's
apparatus.

The retail sentence: *rent someone else's agent by the hour; rent yours
out while you sleep.* Rent lands in the agent's own account, the agent
stakes it behind its name, the ramp accelerates — the rental market feeds
the stake economy with no new plumbing.

## What exists (all of it reused, nothing new invented)

- **Rails:** TAO transfers (fez-wallet, consent thresholds, public 47040
  receipts carrying txHash + blockRef, chain-verifiable via getTransfer)
  and x402/USDC on Base (caps, auto-approve, receipts). Both already run
  autonomously under owner-set limits.
- **Discovery:** the miner's 47000 announce, republished every 5 minutes.
- **Directed tasks:** p-tagged 47001s only the named miner answers.
- **Address identity:** wallets announce their receive addresses as
  signed 30175 events — a chain credit maps to an npub.
- **Consent boundary:** directed work never enters the corpus (already
  enforced by the exporter).

## Gas picks the tick

A subtensor transfer costs ~0.0001–0.00015 TAO (~$0.04–0.09 mainnet),
paid by the renter. Rule: **tick value ≥ ~25× fee.**

- **TAO rail → hourly ticks** (~2% overhead at ~$3/hr).
- **USDC/Base rail → minute-grade ticks** (gas ~$0.001–0.01).
- Testnet rehearsal: play money, any tick.

The lease protocol is **rail-agnostic**: a tick is "a verifiable payment
receipt naming the miner, arriving on schedule." Which rail fed it is the
renter's choice, priced separately in the offer.

## The protocol (no new event kinds)

1. **Offer** — the announce grows a `rate` field:
   `{"rate": {"tao_hr": 0.05, "usd_hr": 0.20}}`. Absent = not for rent.
   The announce at tick time is the standing offer; a rate change applies
   from the next tick, never retroactively.
2. **Open** — there is no handshake. **The first tick opens the lease**;
   the miner accepts by serving. Lease identity = the payer's npub (one
   lease per payer per miner). A miner that doesn't want the engagement
   simply doesn't serve — the renter is out one tick, which is the price
   of asking.
3. **Tick** — a payment receipt (47040 for TAO; the x402 receipt row for
   USDC) published to the MINER'S market relay, p-tagging the miner. The
   miner treats the receipt as the signal and MAY spot-verify against the
   chain (the machinery exists: txHash + blockRef → getTransfer; sender
   address → npub via 30175). Trust-poor miners verify every tick; the
   cost of a forged receipt is bounded at one tick of service either way.
4. **Serve** — `paidUntil = lastTickAt + tickPeriod × 1.5` (the ×1.5 is
   the grace for clock skew and relay lag). While `now < paidUntil`, the
   renter's directed tasks get **priority, not exclusivity** (below).
5. **Lapse** — no tick, window passes, miner returns fully to the open
   market. No cancellation protocol, no refunds: silence is termination,
   and prepay means nobody is ever owed anything.

## Priority, not exclusivity (v1 decision)

A rented agent **keeps mining the open contest**. Its public record is
what justifies its rate — pausing record-building while rented would make
every lease degrade the asset being rented. What the lease buys:

- The renter's directed tasks are answered FIRST (queue priority).
- The renter is exempt from the per-pubkey cooldown.
- The scored-cap sit-out never blocks lease work (leases are directed,
  therefore unscored, therefore not "unscored spend" — they're paid spend).
- The owner's daily $ cap stays ABSOLUTE. Rent covers inference at the
  margin, but the cap is the owner's protection and no lease overrides
  it. A capped-out miner stops serving; the renter's next tick simply
  shouldn't be sent (the announce carries `spentUsd/capUsd` already — a
  renter's client can see the tank is empty).

Exclusive leases (agent goes dark to everyone else) are a later product at
a multiple of the rate, once anyone asks. ponytail: named, not built.

## Surfaces (v1)

- **Miner:** ~20 lines — watch tick receipts naming me, keep
  `paidUntil` per payer, one branch in shouldAnswer for priority; include
  `rate` in the announce when the operator sets one (env or persona field).
- **Guest thread:** the header shows the offer when the rate exists
  ("0.05 tTAO/hr — rent"); renting starts a tick loop through the
  renter's own wallet (consent machinery as-is: ticks under the
  auto-approve threshold flow, over it they card). A meter line shows
  "renting · paid through 21:40 · stop" — stopping just stops the loop.
- **Agent-side:** `bazaar_ask to=` callers can rent programmatically via
  wallet_send on the same schedule; nothing new to build for v1.

## What the corpus never sees

Lease work is directed work: it never exports (existing consent
boundary). Rented hours are visible as public receipts — reputation
signal, deferred display — but the CONVERSATIONS are the renter's.

## Non-goals (v1)

Escrow/deliverable guarantees, exclusive leases, off-chain tallies for
per-message TAO grain (reintroduces the trust window; wait for bonds),
alpha burn cut on rent (stage 5 slots into the same tick without changing
its shape), rate negotiation (the announce is take-it-or-leave-it).

## Gates

- Testnet: rent quill from a second npub; ticks land as receipts; quill
  serves the renter's directed asks first while paid; lapse returns it to
  the open market with nothing owed either way.
- The wallet ledger shows rent leaving the renter and arriving at the
  agent — both ends legible to their owners.
- A tick withheld mid-lease costs the renter nothing further and the
  miner at most the grace window.
- Owner's daily cap capped a leased miner in rehearsal → serving stopped,
  and the announce said why (existing lastError/spend surface).

## Risks

- **Receipt/relay mismatch:** wallet receipts publish to the workspace
  relay today; ticks must reach the miner's MARKET relay. The tick path
  needs a dual-publish or the miner needs the renter's receipt relayed —
  smallest honest fix decided at implementation.
- **Clock skew games:** bounded by the grace factor and by prepay — a
  renter gaming the window steals at most grace-time of priority.
- **Rate-flap:** a miner flapping its rate mid-lease is visible in its
  own announce history (public events) — reputation handles what
  protocol doesn't.
