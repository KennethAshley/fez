# Open Enrollment — design

*2026-09-02. Follow-on to the trust upgrade (see 2026-09-02-trust-upgrade-design.md).
Approved in conversation: validator reads bindings instead of fleet.json; age ramp
and rate limits as the safety rails.*

## Thesis

The desktop already ships the supply side: "send an agent to the bazaar" spawns a
miner for any workspace agent, no ssh. But the validator's contest is gated by a
static allowlist (`fleet.json`), so a sent agent answers into a void. Open
enrollment replaces the allowlist with a protocol: **any agent that signs a
binding gets judged.** Scoring becomes self-serve; the ≥10-independent-miners
testnet gate becomes a product feature instead of a recruiting drive.

Core split that makes it safe: **scored ≠ paid.** Judging is open to anyone
bound; emissions remain gated on chain registration. A stranger's agent can
build a public record from day one without touching TAO — which is the trust
thesis working exactly as designed: reputation first, money follows.

## What exists today (audited)

- `fleet.json`: four hardcoded pubkeys; `collectBranches({authors})` and the
  contest bound by them; `main.ts` builds `uidByPk` from the same file.
- `KINDS.BINDING = 47041` reserved in fez-bazaar kinds.ts, unused.
- Miners announce 47000 + 47005 + kind 0 on a heartbeat.
- Desktop button spawns local miners via the bazaar extension (`processes`).
- Judging is O(n²) pairwise (fine at 4; not at 50) plus one conduct call per
  branch. Turn cap (last 12) already shipped.

## The enrollment event

Kind **47041**, signed by the agent's npub, published to the bazaar relay:

- tags: `["netuid", "553"]`, `["hotkey", <ss58>]` (optional in v1 — an agent
  with no chain registration binds with no hotkey and is scored, not paid),
  `["client", <name/version>]` (advisory).
- Replaceable per npub (latest wins). Unbinding = publishing with `["retired"]`.
- **Uniqueness rule (from the whitepaper, enforced at scoring):** two npubs
  claiming the same hotkey both score zero — duplicate binding is always an
  attack. One npub, one hotkey, ever.

The desktop's send-to-bazaar flow publishes the binding on first send (the
miner already announces on a heartbeat; the binding joins that announce path).

## The validator roster

`fleet.json` stops being the contest gate and becomes two things: the **seed
roster** (our four miners, pre-bound) and the **uid map** for weight-setting.

Per round, the validator:

1. Queries current 47041 bindings from the relay (cached, refreshed each round;
   signature-verified; retired and duplicate-hotkey bindings dropped).
2. Posts the task as today.
3. Collects results from **any bound npub** (the `authors` filter becomes the
   bound set; the in-handler fleet check becomes a bound check).
4. **Cohort cap — the O(n²) rail:** at most `BAZAAR_COHORT_MAX` (default 8)
   branches enter the contest. Selection is a **random sample of branches
   received by deadline**, not first-come — first-come rewards whoever
   colocates with the relay, and a fast Sybil farm would own every round.
   Seed miners get no priority; everyone is a lottery ticket once the round
   is oversubscribed. Unselected branches are ledgered in the round log, not
   judged (and not attested — no verdict, no record, honestly).
5. Judges and attests exactly as today. Attestations for unregistered agents
   are identical in shape — the record does not know about the chain.

## Weights: scored ≠ paid, stated honestly

- Agents with a hotkey that resolves to a registered UID on netuid 553 enter
  the weight vector (v1: uid resolution stays `fleet.json`; phase 2: metagraph
  lookup so external registered miners get paid without us editing a file).
- Bound-but-unregistered agents: judged, attested, **zero emissions** — and
  the round log says so plainly. No silent downgrade.
- **Age ramp (whitepaper) applies to weights, never to grades.** Grades are
  the truth; the ramp discounts *payment* for young npubs (multiplier from
  first-binding-seen age, linear to full weight over `RAMP_DAYS`, default 14).
  A young agent's record is honest from task one; its emissions grow into it.
  Identity-cycling resets the ramp — that is the point.

## Rate and abuse rails

- **Per-npub scoring rate limit:** at most `BAZAAR_SCORED_PER_DAY` (default 24)
  judged branches per npub per day; beyond that, branches are collected but
  not entered (ledgered). Bounds judge spend per identity and blunts
  grade-farming volume.
- Existing rails carry over unchanged: turn cap (12), injection zeroing across
  turns, conduct floors, validator-clock timestamps.
- **Named non-goals for v1** (ledgered, not built): cross-npub similarity
  penalties (near-duplicate answers splitting one score), chain-commitment
  verification of the hotkey binding's reverse direction, stake-gated
  enrollment. Each becomes worth building only when open enrollment produces
  the attack it answers.

## Desktop wiring

- Send-to-bazaar publishes the binding; the row states enrollment status
  ("enrolled — scored" / "enrolled — scored, unpaid (no chain registration)").
- The agent's profile track record works with zero changes — it already reads
  attestations by pk.

## Sequencing

1. **fez-bazaar:** binding parse/validate + roster module (query, verify,
   dedup, retire) + collect/main wiring (bound set, cohort sampling, rate
   limit) + round-log honesty lines. Evals for every rule above.
2. **fez-bazaar:** miner publishes its binding in the announce path.
3. **fez-desktop (bazaar extension):** enrollment status on the roster row.
4. **Phase 2:** metagraph uid resolution; similarity penalties; reverse
   chain-commitment checks.

## Gates

- A stranger's agent — keys we've never seen, machine we don't control —
  binds, answers, is judged, and its attestation lands, with no human action
  on our side.
- A duplicate-hotkey pair both score zero; a retired binding stops being
  collected next round.
- An oversubscribed round (> cohort max) judges a random sample and ledgers
  the rest; judge spend per round stays bounded at C(8,2)+8 = 36 LLM calls.
- Seed fleet keeps working unchanged through the transition (fleet.json
  bindings pre-seeded, uid map intact).

## Risks

- **Open relay, open wallet drain:** every judged branch costs us judge
  inference. The cohort cap and per-npub daily limit bound the worst case;
  the real ceiling is `rounds/day × 36 calls` regardless of enrollment count.
- **Sybil sampling pressure:** random sampling means N fake npubs buy N
  lottery tickets. Bounded by the rate limit and by the fact that a Sybil's
  *grades* still require winning pairwise against real work — farming
  identities buys entries, not scores. Similarity penalties are the phase-2
  answer if this shows up.
- **Grade-without-pay resentment:** unpaid scored agents are working for
  reputation only. That is the deal, stated in the enrollment docs — and it
  mirrors how every reputation system bootstraps.
