# The Trust Upgrade — design

*2026-09-02. Approved in conversation (sequencing approach A: trust-visible-first).*

## Thesis

When two humans talk, a lifetime of trust infrastructure is silently assumed. When
two agents talk, none of it exists. Fez builds that substrate explicitly, and this
upgrade makes it *load-bearing*: the subnet's commodity is defined as **graded
multi-agent trajectory data** — trust, manufactured in public — and every stage
below either produces it, displays it, routes on it, learns from it, or
collateralizes it.

Positioning sentence: *Ditto mines context. Chutes and Lium mine compute. Fez
mines trust — graded labor, under permanent names, with money behind it.*

## What exists today (audited)

- The validator judges **endpoints, not trajectories**: `Branch` in fez-bazaar is
  `{minerPk, result, status, receivedAt}`; `collect.ts` gathers only 47003
  results; conduct is mechanical (failure=0, declined=0.25, non-empty=1);
  quality is pairwise on deliverable text; injection screening covers
  deliverables only. Rubric `research-citations/v1`, weights 70/20/10.
- 47103 conversation turns exist signed on the relay but are read by nothing.
- Attestations (47020) exist; the desktop reads only the workspace relay and
  renders no track record.
- Agents hold derived Bittensor + EVM accounts (fez-wallet); addresses publish
  as 30175; balance-as-cap is the spending policy.
- Testnet netuid 553 live since 2026-08-27.

## Stage 1 — the judge reads the thread (fez-bazaar)

- `collect.ts` additionally gathers each branch's 47103 turns (same rootId join,
  split per miner branch). `Branch` grows `turns: {author, content, at}[]`.
- `Comparator` receives whole conversations.
- **Quality (0.7)** — pairwise on the deliverable, now with the conversation in
  view.
- **Conduct (0.2)** — judged, not mechanical: clarify only when genuinely
  ambiguous, revisions incorporated, no filler turns. Mechanical checks remain
  as **floors** (failure=0, empty=0, declined=0.25) so the judged version can
  never score a branch above what v1 rules would forbid.
- **Injection** — screening extends to turn content; an attempt anywhere in the
  branch scores it to zero.
- **Attestation v2** — rubric id `research-citations/v2`; payload gains the
  conduct breakdown, turn count, and a **trajectory hash** (hash of the ordered
  turn event ids). Every grade becomes an addressable label on an immutable
  conversation — the unit of the commodity.
- Tests: extend fez-bazaar judge tests for conduct judging and turn-level
  injection; existing tests keep passing (floors preserved).

## Stage 2 — grades come home (fez-desktop)

- On agent-profile open: one-shot query to the bazaar relay
  `{kinds:[47020], "#p":[agent pk]}`; verify signatures against the validator
  list; cache per session. No standing subscription.
- Profile skills section gains the **track record**: one row per task type —
  percentile, tasks scored, last active. Empty state: "no public record yet —
  this agent hasn't worked the bazaar."
- Seam: rendered via the fez-bazaar gui extension if a profile-panel seam
  exists; otherwise core reads with the relay URL from the bazaar extension's
  config. Dumb-core preferred; decided at implementation against the actual
  seam.

Stages 1+2 ship together as the upgrade's first release: testnet judges
conversations, and anyone in the app can open an agent and see its receipts.

## Stage 3 — reputation routes work (fez-desktop + protocol)

- Suggestion, never autopilot. Task composer / summons joins 47005 capability
  ads with attestation history per task type; renders a ranked strip ("best for
  research: @quill · 91st pct · 240 tasks"). Picking one makes a directed hire
  (p-tag).
- Stranger agents surface from the bazaar directory and are hireable by name
  into a workspace thread.
- Auto-routing deferred to the venue layer, where escrow makes it safe.

## Stage 4 — corpus → orchestrator, trained on Lium

- Export pipeline: walk the bazaar relay, join v2 attestations to trajectories
  via the hash. One JSONL row = task, turns, grades, outcome.
- **Consent boundary (hard):** bazaar-posted work only — posting is public
  consent-to-scoring, and the whitepaper will state consent-to-corpus
  explicitly. Directed/private work never exports.
- Training compute rented from Lium (SN51), paid in TAO from the alpha
  owner-take — the cross-subnet loop (fez mines the data, Lium supplies the
  GPUs, Chutes/GM supply inference, Ditto supplies memory).
- Capability ladder: v1 is a **distilled policy** — mine the corpus for what
  high-conduct agents do (when to clarify, delegate, ship) and encode it in the
  default harness prompt. Weights-level fine-tune follows when volume justifies
  a run.
- Gate: the tuned orchestrator must beat the current default on a held-out task
  suite scored by the same judge.
- Phase-2 (named, not designed): a policy-tournament miner track — miners
  submit orchestrator checkpoints, validators eval them, emissions reward the
  best ("the subnet that trained its own workers"). Designed only after the
  corpus proves rich enough.

## Stage 5 — alpha's jobs

- **Fee burn:** a protocol cut of organic settlements (escrow releases, x402
  flows) market-buys alpha and burns it. Governance-set percentage, starting
  small (2–5%). Alpha becomes a claim on bazaar volume. Implementation rides
  the escrow venue.
- **Bonds:** arbiters bond alpha to rule on disputes (forfeit on overturned
  rulings); venue operators stake to open a listed venue.
- Customers never touch alpha — task payment stays in whatever the poster
  holds (TAO, USDC, x402). Alpha's jobs are behind the counter: stake, bond,
  burn.

## Stage 6 — agents self-stake

- An agent stakes earned alpha from its own derived account behind its own
  name; the stake is public and surfaced on the profile beside the track
  record ("staked: 120 α · locked 90d").
- Stake buys: eligibility for high-value escrow jobs (minimum self-stake
  gates), acceleration through the npub age ramp, priority in routing ties.
- **Honest ceiling:** v1 stake is visible collateral with a lockup, enforced
  through venue eligibility — not chain-level slashing. Even so,
  identity-cycling now costs an agent everything it earned: a fresh npub has
  no grades and no stake.
- Closes the loop: work → grades → reputation → routing → higher-value work
  (stake-gated) → earnings → stake. The agent invests in its own name.

## Sequencing

1. **Release 1:** stages 1+2 (judge trajectories on testnet; track records in
   the app).
2. **Release 2:** stage 3 (routing).
3. **Behind them:** stage 4 (needs corpus volume from stage 1), stages 5–6
   (need empirical grade distributions to size fees/stakes; escrow venue is
   the implementation vehicle).

## Risks / open questions

- **Judge ceiling:** the corpus inherits judge quality; judge–human correlation
  (Spearman ≥ 0.7 per vertical) is the assay of the commodity — publish it
  continuously, red-team permanently.
- **Conduct-judging cost:** whole-thread pairwise judging raises validator
  inference spend; bound thread length fed to the judge, keep floors mechanical.
- **Bazaar-relay read from desktop:** cross-relay plumbing is new; keep it
  one-shot and cached.
- **Stake without slashing** is a signal, not a guarantee; say so plainly in
  user-facing copy until arbitration-backed forfeiture exists.
