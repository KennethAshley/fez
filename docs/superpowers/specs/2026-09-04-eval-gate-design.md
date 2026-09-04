# The eval gate — corpus → orchestrator, stage 4's measuring stick

**Date:** 2026-09-04 · **Repo:** fez-bazaar, branch `eval-gate` · **Status:** approved design

## Why this exists

The trust-upgrade spec (2026-09-02, stage 4) sets the rule: *a tuned
orchestrator must beat the current default on a held-out task suite scored by
the same judge.* Nothing enforces that rule today. This gate is that
enforcement, built **before** any distiller — a policy candidate without the
gate is vibes; the gate without a candidate is still a reusable instrument
(it will score every future candidate, including eventual fine-tunes).

## What "orchestrator" means today, concretely

For research-citations — the only judged, corpus-feeding task type — a
miner's body is **one `Provider.complete()` call**: a shared safety `SYSTEM`
half (inline in `src/miner/main.ts`) plus `profile.system`, the per-miner
"how you work" style (`src/miner/profiles.ts`). **`profile.system` is the
tunable policy.** The full pi/claude-code harness only runs for repo-work
hires, which are never judged and never enter the corpus. The gate therefore
drives the miner's real body — the provider call with the real SYSTEM
assembly — not a harness and not an approximation.

## Design

An offline A/B module in fez-bazaar, `src/gate/`. No relay, no chain, no
live miners. Per gate run: 2×N completions + N pairwise comparisons.

### Files

- **`src/gate/holdout.json`** — ~10 hand-written research-citations tasks,
  disjoint from the live pool in `src/validator/tasks.json`, never posted to
  the bazaar. The holdout is the control surface: a task that leaks into the
  live pool is burned and must be replaced.
- **`src/gate/run.ts`** — the pure half. Given a task, two system prompts
  (arm A: current `profile.system`; arm B: candidate), a `Provider`, and a
  `Comparator`: produce two `Branch`es via the existing `classifyResponse`,
  score them with the existing `scoreBranches`, return the per-task verdict.
  Arms are judged anonymously as branch a/b, exactly as production judges
  miners. Both arms run the chosen profile's model — the experiment varies
  the prompt and nothing else.
- **`src/gate/main.ts`** — the CLI:
  `bun run src/gate/main.ts --candidate policy.md [--profile <id>] [--out gate.jsonl]`
  (flags via `node:util.parseArgs`). Emits one JSONL row per task (both
  branches, verdict, scores) for audit, then the tally. Every skipped or
  failed round is counted and said out loud — the no-silent-caps rule.

### The gate rule

**PASS iff the candidate wins strictly more tasks than it loses** (ties
carry no signal). A comparison the judge could not reach
(`ComparisonUnavailable`) is reported as unavailable, never converted into
a verdict — same semantics as the validator.

### Refactors (sameness made provable, not copy-pasted)

- Lift the `SYSTEM` assembly out of `src/miner/main.ts` into
  `src/miner/system.ts`; miner and gate import the same builder.
- Lift `anthropicComparator` out of `src/validator/main.ts` into
  `src/validator/comparator.ts`; validator and gate import the same judge.

Behavior-preserving moves only. If the gate's prompt or judge can drift from
production, the verdict stops meaning anything.

## Testing

`bun test` with stubbed provider and comparator (deterministic):
- tally math — win/loss/tie counting and the strict-majority pass rule
- tie and `ComparisonUnavailable` handling — withheld, not invented
- prompt identity — the gate's assembled system prompt for a profile equals
  the miner's for the same profile

Live provider/judge calls are not unit-tested; they are the same code paths
production already exercises.

## Known ceilings (deliberate, marked in code)

- **N≈10, single round** is a weak sample — enough to wire and smoke the
  gate, not enough to trust a close verdict. Widen the holdout (and/or run
  k rounds per task) before believing a marginal PASS.
- **Same judge = same biases.** The gate inherits the production
  comparator's blind spots on purpose; it measures "wins under the judge
  that pays," not platonic quality.

## Non-goals (v1)

- No distiller — that's the next deliverable, whose output this gate scores.
- No fine-tuning, no Lium compute, no policy-tournament track.
- No eval framework dependency (promptfoo/Inspect/Braintrust considered and
  rejected: each substitutes its own judge or runner for the production
  ones, which is precisely what the gate must not do). No new dependencies
  at all.
