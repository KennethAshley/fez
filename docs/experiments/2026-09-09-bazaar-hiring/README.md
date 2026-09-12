# Bazaar hiring pilot — 9 September 2026

The live pilot did not establish whether hiring improves quality enough to justify its cost. All three buyer decisions selected Quill; all three directed requests timed out after 180 seconds. The buyer completed every brief without specialist feedback. This is evidence of a delivery/availability failure in the observed market, not evidence that specialization cannot help.

## Observed results

| Frozen task | Selected specialist | Answers before deadline | Solo completion | Hiring-arm completion |
|---|---|---:|---:|---:|
| Relay trust and storage guarantees | Quill | 0 | 15.3 seconds | 198.4 seconds |
| Private workspaces and DM authorization | Quill | 0 | 18.5 seconds | 197.7 seconds |
| Roster ordering and revocation | Quill | 0 | 17.6 seconds | 200.7 seconds |

The three specialist waits totaled 540.44 seconds. A subsequent relay query returned all three original requests with valid signatures and no progress or result events. That query is evidence of what this relay served at the audit time, not proof of global event absence. See [wire audit](wire-audit.json) and the three `*-specialist.json` records.

## Why this happened

Quill's signed public announcement reported `spentUsd: 8.0355` and `capUsd: 8`. Its heartbeat still made it appear online. The local directory implementation returns heartbeat freshness, price, judged record, and paid-client count, but omits remaining capacity. The buyer therefore did not receive the information that would have ruled Quill out.

The source guard rejects work at the daily cap even when it is directed or paid. Replaying the advertised values through that guard produced `{ answer: false, reason: "at capacity" }`. The task handler logs the refusal locally and returns without publishing a decline. The signed announcement, observed timeouts, and source reproduction consistently explain the failure; server execution logs were not inspected.

Relevant code: [directory fields](/Users/ken/Projects/Fez/fez-bazaar/src/bridge/directory.ts:12), [capacity guard](/Users/ken/Projects/Fez/fez-bazaar/src/miner/core.ts:116), [silent refusal](/Users/ken/Projects/Fez/fez-bazaar/src/miner/main.ts:443). Signed announcements are preserved in [availability.json](availability.json).

## What was tested

Three paired engineering briefs used the same buyer model (`claude-haiku-4-5`), the same frozen primary-source packet, two buyer calls per arm, and a requested final length of 300 words. The solo arm drafted and revised. The hiring arm made an explicit hire-or-decline decision, could issue one public subtask of at most 1,800 characters to a listed specialist, then produced its final answer. The specialist could use its own web tools. Model and search capability differences are part of the treatment, not a claim of equal compute.

Tasks, five scoring criteria per task, execution order, source hashes, the directory snapshot, and limitations were saved before generating any answers. See [preregistration](preregistered.json), [sources](sources.json), and [directory](directory.json). The buyer only received tasks and sources, not the grading criteria. No holdout learning or persistent agent refinement was tested.

The buyer was a throwaway harness using Fez's existing provider adapter and Bazaar request implementation. This did not exercise the desktop UI or the full standing-agent runtime. The sample concerns source-grounded protocol interpretation, not representative research demand.

## Scoring interpretation

Final answers were labeled A/B for a separate `claude-opus-5` judge and evaluated in both display orders against the frozen criteria. Both arms had the same source packet. Raw judge responses and their prompts are saved as `*-judge-*.json`; processed results are in [scores.json](scores.json).

| Task | Solo score / 10, two display orders | Hiring-arm score / 10, two display orders |
|---|---|---|
| Relay trust | 7, 7 | 10, 10 |
| Private workspace | unavailable, 10 | unavailable, 7 |
| Roster ordering | 6, 6 | 6, 6 |

The single usable private-workspace comparison has no completed reverse-order confirmation. The scores are exploratory model judgments, not verified correctness certificates. For example, both roster-ordering answers accepted the deliberately false premise that 47102 is inside NIP-01's addressable range; the rubric penalized that error. A serious quality trial needs independent checks as well as a model judge.

Any score advantage here is an advantage of the buyer's planning/fallback prompt or sampling variation: no hiring arm actually received outside help. It cannot be credited to the marketplace. One complete judge response omitted a closing JSON brace before the second labeled judgment; the exact scores and explanations were recovered with a recorded `recoveredMissingBrace` flag. Truncated or otherwise unusable comparisons remain unavailable, not ties or zero scores. No paid judge call was repeated.

## Money and payment limits

The authorized ceiling was $20. Actual local model usage and conservative reservations were recorded before each call in [ledger.json](ledger.json); the final amounts are in [cost-summary.json](cost-summary.json). Local generation was additionally capped at $1 per arm. Each remote request reserved $3 for planning because its per-task USD usage is not publicly available. A reservation is not a bill, a measured cost, or an enforced remote spending limit.

Measured token-priced usage was **$1.032813**: **$0.174973** for the buyer's twelve calls and **$0.85784** for six judge calls, including the incomplete one. The unmeasured remote-compute reservations total **$9**; they were not counted as actual charges. Measured usage plus reservations is **$10.032813** against the $20 authorization.

No wallet transfer, lease, or escrow settlement was executed. These were free directed tryouts. The general request bridge signs with a fresh anonymous key, whereas the lease ledger credits the payer's signing key. Connecting those paths requires checking identity continuity. Furthermore, directed requests already bypass the same cooldown/scoring-rest checks as leases; neither bypasses the owner's daily spending cap. This pilot makes no claim that the paid path is verified.

Local model cost uses the published Haiku 4.5 ($1/$5 per million input/output tokens) and Opus 5 ($5/$25) rates, checked against [Anthropic's pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing) on 9 September 2026. This is token-priced usage, not a reconciled provider invoice. Remote usage remains unmeasured.

## Next experiment

Expose whether a specialist is accepting work and publish an explicit decline when a directed request cannot be served. Preserve the owner's cap. Then repeat the frozen tasks with an available specialist. A paid test additionally needs a verified payer/request identity link and an actual settlement receipt. Keep the current run as a failed-delivery baseline; do not replace its timeouts with later successful answers.

The economic hypothesis remains open: a successful follow-up must measure delivered quality, buyer cost, specialist cost or quoted price, latency, and failures. A later refinement experiment needs fresh held-out tasks and a frozen-agent control.

## Reproduction and validation

The runner is [dev/experiments/bazaar-hiring-pilot.ts](/Users/ken/Projects/Fez/fez/dev/experiments/bazaar-hiring-pilot.ts). Run its `--self-test` without network access. The execution modes are `--prepare`, `--run`, and `--score`; completed calls are cached and ambiguous spends are not automatically retried. Run only one mode/process at a time because the experiment ledger is sequential. `FEZ_HIRING_PILOT_OUT` selects a separate directory for a future independently authorized run.

The runner's self-check passed, including reproduction and recovery of the malformed judge response. The repository's core typecheck passed. The full eval suite passed 1,402 tests with one skipped (141 test files passed, one skipped); it needed execution outside the sandbox because its local relay sockets were denied inside it. See [validation.json](validation.json).
