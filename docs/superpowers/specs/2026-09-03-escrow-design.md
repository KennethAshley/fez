# Escrow — a hire that pays, without a custodian

*2026-09-03. Trust upgrade stage 5's core. Follow-on to streaming leases
(which needed no escrow) and the corpus (whose trajectory hash is the
delivery proof escrow pays against). Decisions are proposals; objections
edit them.*

## Thesis

A lease buys attention and self-enforces tick by tick. A **hire buys a
deliverable** — a lump sum for a result — and that shape needs escrow to
be safe: the poster won't pay before delivery, the worker won't work
before the money is real. Escrow closes that standoff **without a
custodian**: the funds sit at an address only 2-of-3 of {poster, worker,
arbiter} can move. Nobody is trusted to hold the money; two honest
parties always suffice, and the arbiter only matters when they disagree.

The primitive is native — subtensor exposes the substrate `multisig`
pallet (verified on testnet). No smart contract, no new pallet, no
trusted escrow service.

## What exists (audited on the live chain)

- `multisig` pallet: `asMulti`, `approveAsMulti`, `cancelAsMulti`. A
  multisig ADDRESS is deterministic from (sorted signatories, threshold)
  — anyone can fund it; dispatching a call FROM it needs `threshold`
  signatories to approve the SAME call hash.
- `scheduler` (deadline auto-refund, later), `proxy`, `utility.batch`.
- fez-wallet already signs sr25519 transfers and reads balances; the
  trajectory hash already proves what was delivered; the judge already
  scores bazaar work; agents already hold their own keys.

## The escrow, mechanically

An escrow is a 2-of-3 multisig over three sr25519 keys:

- **poster** — the hirer's persona account (funds the job).
- **worker** — the hired agent's own account (its hotkey/derived key).
- **arbiter** — a staked arbiter agent, chosen from a published list.

Address is derived deterministically (`createKeyMulti` + SS58) — no
setup transaction, no deploy. The lifecycle:

1. **Open + fund.** Poster posts the hire (a directed 47001 with an
   `escrow` tag naming the arbiter and amount) and transfers the amount
   to the derived multisig address. The address in the tag lets the
   worker verify the money is real before lifting a finger.
2. **Deliver.** Worker answers as usual (47003, trajectory-hashed). For
   bazaar-typed work the judge scores it; for anything else the arbiter
   is the reader.
3. **Release (happy path).** Poster + worker both `approveAsMulti` the
   SAME "pay worker" call. Two of three → funds move to the worker. The
   arbiter never signs, never sees a dispute, earns nothing. This is the
   overwhelmingly common path and it is fully peer-to-peer.
4. **Dispute.** Poster and worker disagree (one won't release, or one
   won't accept). The arbiter reads the trajectory (the hash makes it
   the exact graded conversation) and signs with one party: arbiter +
   worker → pay; arbiter + poster → refund. The arbiter's bond is
   slashable if a ruling is later overturned by governance (deferred).
5. **Timeout.** No delivery by deadline → poster + arbiter refund. Later:
   `scheduler` auto-submits the refund approval so the poster needn't
   babysit.

## The judge as the honest default oracle

For work the bazaar judge already grades (research-citations today), the
attestation IS the release signal: a passing score is the worker's
evidence, a failing/absent score is the poster's. v1 can ship escrow for
JUDGED task types first — the release is "did the signed attestation
clear the bar" — and treat the human arbiter as the escalation path, not
the default. This is the smallest real escrow: it reuses the entire
scoring apparatus as the delivery oracle and only falls back to a person
when the automated verdict is contested.

## The verbs (fez-wallet, ceremony-seam compatible)

1. `escrow open <persona> <worker-pk> <arbiter-pk> <amount>` — derive the
   address, fund it, return `{escrow, callData}` for the release later.
   Refuses mainnet under testnet config (existing guards).
2. `escrow release <persona> <escrow-id>` — approve the pay-worker call.
   When this is the 2nd approval, funds move; when the 1st, it waits.
3. `escrow refund <persona> <escrow-id>` — symmetric, pays the poster.
4. `escrow status <escrow-id>` — chain-read: funded balance, approvals so
   far, whether it has released. Pure read.

Agent-side: `wallet_escrow_release` so a worker can claim its own pay once
it sees the poster's approval — the agent collects its own earnings.

## Non-goals (v1)

Governance-backed slashing of arbiter bonds (the ruling is final in v1;
the bond is a signal), scheduler auto-refund (poster refunds manually
first), escrow in the GUI (CLI + agent tool first, one surface done),
multi-worker/crew splits, escrow for the streaming lease (leases don't
need it — that's the point).

## Gates

- Testnet, three keys: fund a 2-of-3 escrow; poster+worker release to the
  worker; the arbiter never signs. Verified on chain.
- A dispute path: arbiter+poster refund a funded escrow the worker
  cannot unilaterally take.
- `escrow status` reads funded/approved/released honestly, and a
  wiped/unreachable chain reads unknown, never a stale "released."
- Every verb refuses the wrong network (existing guards, exercised).

## Risks

- **Multisig call-hash discipline:** both approvers must approve the
  BYTE-IDENTICAL call, or the approvals don't combine. The verb builds
  the call once and shares its bytes; a mismatch is a bug the live gate
  catches.
- **Deposit mechanics:** `asMulti` reserves a storage deposit from the
  initiator, returned on completion — small, but it must come from a
  funded account and be surfaced, not a surprise.
- **Arbiter availability:** a chosen arbiter that never signs freezes a
  disputed escrow. v1 mitigation: pick from arbiters with a live
  heartbeat; real fix is bonds + rotation (deferred).
