# First approved Bazaar coordination rehearsal

The separately approved [second rehearsal](2026-09-11-bazaar-gauntlet-rehearsal-2.md) completed the spoken delivery but remained unassessed because the validator could not download the audio. This document preserves the first attempt unchanged.

Outcome: **rejected before the specialist handoff**. Exactly one job ran. The existing mandatory acceptance scorer recorded zero eligible quality and zero total score. The speaker was never invoked; no new audio was produced.

Ken approved the staged one-job proposal on September 11, 2026: USD 1 of reported model usage per agent, possible provider-call overshoot, zero service transfers, no retries, and no reward changes. The frozen job SHA-256 was `adbd652c7ad5c36ab991e0c11870d72db16050d61efb287bb92e9a5ced84a86d`.

| Measurement | Observed result |
| --- | --- |
| Coordinator model usage | USD **0.500994**, worker-reported; not an invoice |
| Speaker model usage | USD **0**; not invoked |
| Specialist service transfers | **0 tTAO** |
| Eligible quality / total score | **0 / 0** |
| Reward status | **not-submitted** |

The actual `fez` worker enrolled on a fresh loopback-only relay and claimed the directed job. The first coordinator phase failed before producing a parsed script/specialist choice. The signed outcome records `workflow-failed`, with known usage inside the authorized allowance. The failed job will not be relabeled or retried.

The recorded response confirms the cause: the agent returned valid fenced JSON containing the exact approved script and specialist, followed by explanatory prose. Bazaar removed the opening fence but only removed a closing fence at the very end of the response. The prose left the closing fence inside the text passed to `JSON.parse`, which threw before the parsed script could be assigned. The runtime reported a normal `end_turn` and known cost; this was a response-parser integration bug, not a missing script or an exhausted allowance. Sanitized final-response evidence and exact payload comparisons are in `run/coordinator-approved-response.json`; no private reasoning is included.

The parser is now fixed in `fez-bazaar/src/miner/coordination.ts`: raw JSON and one leading JSON code block with trailing commentary are accepted. Multiple fenced alternatives, malformed JSON, arrays, changed scripts, and unauthorized specialist selections are still refused. Both planning and review use the same parsing path. The regression tests also verify that refusals preserve reported costs and cannot publish an acceptance or delivery.

Post-fix validation: **340 Bazaar tests passed**, typechecking passed, and all Bazaar builds passed. A replay of the exact recorded response prepared the expected handoff, then deliberately stopped before signing; it made **zero model calls and published zero events**. Evidence: `run/parser-fix-recorded-replay.json`. The original staged release and signed rejection remain preserved; the corrected build has not been installed or deployed to live services.

Execution began at 03:20:04 UTC, the task was observed at 03:20:07 UTC, and the validator's rejection arrived at 03:20:44 UTC. The operator stopped all rehearsal processes by 03:20:45 UTC. The worker published its retired binding. Port 17777 is no longer listening. The one-run approval was consumed locally and on the validator host.

The production service processes, binaries, configuration hashes, and reward-path hashes match their pre-staging snapshot. No installed persona or runtime was replaced, no public Bazaar enrollment was made, and no wallet, stake, SALT, or payout mutation was requested by this job.

Evidence is retained under `/private/tmp/fez-bazaar-staging-20260911T024004Z/run`:

- Task: `8773611d2596074c1d465805c1d7c51e6bf90c6720839b128776cb4363724905`.
- Validator assessment: `7424257792d49141e21665b151244d13d4bc9fa88bc9ce26df090d3c07f35ed1`.
- `result.json`, `validator-47020.json`, and `remote-signed-events.json` retain the outcome, resource record, and signed evidence.
- `relay.jsonl`, `worker.log`, and `bazaar-state.json` retain the single job, recorded cost, and retirement.

The completed rehearsal proves admission, actual-runtime invocation, observed accounting, failure grading, and shutdown. It does not yet prove the full spoken-deliverable path through Bazaar. Another paid attempt requires fresh authorization.
