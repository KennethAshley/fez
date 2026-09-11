# Bazaar hiring rerun — 9 September 2026

The availability fix is deployed. Both chosen hires returned signed replies; the first attempt had three timeouts. One reply was useful analysis and the other was only a lookup marker. Hiring improved one completed quality comparison, but this sample does not establish a reliable quality advantage or validate payments.

## Deployment verified

All four existing miners are active on the new binary, with the same daily caps: Ember $5, Quill $8, Forge $6, Drift $6. Signed announcements expose `acceptingWork`; the public board and desktop/MCP directory share the availability rule. Live HTML and JavaScript match the local files by SHA-256. The public board rendered four available miners.

The deployed Linux binary returned a signed `declined` result in **45 ms** under a $0 cap. This probe used a disposable identity, dummy API key and a private relay through SSH: no model calls or public canary events. See [deployed busy verification](deployed-busy-verification.json), [deployment verification](deployment-verification.json), [binary digest and service state](deployed-miner.txt), and [deployment log](deployment.log). The previous binary remains at `/opt/fez/fez-bazaar-miner.prev` for rollback.

## Experiment results

The same frozen tasks, source packet, rubrics, buyer/judge models and arm order were reused. Availability was re-read before each buyer decision; only specialists reporting `acceptingWork=true` were offered. Each arm used two buyer calls. All six final answers were generated anew. The buyer could choose one specialist or decline. This was a **free directed tryout, not a paid lease or wallet settlement**.

Scores are out of 10; pairs show the two blind display orders.

| Task | Hiring decision/result | Solo time | Hiring-arm time | Solo score | Hiring-arm score |
|---|---|---:|---:|---|---|
| Relay trust | Quill: lookup marker only | 17.2s | 122.0s | 8 / unavailable | 8 / unavailable |
| Private workspace | Quill: substantive analysis | 23.4s | 57.9s | 7 / unavailable | 9 / unavailable |
| Roster ordering | Buyer declined to hire | 18.3s | 19.1s | 5 / 6 | 6 / 8 |

The relay-trust specialist returned only `[lookup 2] FETCH: https://raw.githubusercontent.com/nostr-protocol/nips/master/01.md`, yet labeled it `success`. That is a response arriving, not completed work. The final answer therefore cannot credit a specialist quality gain on that task.

The private-workspace hire supplied substantive analysis in 37.9 seconds. The completed judge comparison favored its final answer 9–7, particularly because it required the agent to authorize task senders independently of DM encryption. The reverse-order judgment was truncated, so the gain lacks that confirmation. My review agrees with the central error in the solo answer: being able to decrypt a message does not restrict who can send a task to the recipient.

For roster ordering, the buyer decided it could answer unaided. Both arms accepted the false premise that kind 47102 is addressable under NIP-01 despite its 30000–39999 range. Any score difference on this task reflects the buyer's prompts or sampling, not hiring.

The hired private-workspace final had 331 whitespace-delimited words and the no-hire roster final 310, exceeding the requested 300; the other finals were within it. This weakens the claim of equal output length.

## Scoring limits

Two reverse-order judge responses exhausted their output budgets and remain unavailable; no paid judge call was repeated. One complete response omitted both the closing brace before B and the final root brace. Those two braces were restored offline, with no scores or text inferred. [Recorded recovery and scores](scores-with-recorded-recovery.json) preserves that transformation and its source hash; [original scoring output](scores.json) remains unchanged. Other missing-brace recoveries are already flagged by the original runner. Three cases and one judge model are exploratory evidence, not a general performance estimate.

## Cost

- Prior pilot: **$1.032813**. Server logs prove the three original remote requests were skipped before model calls; their $9 reservations were released. [Evidence](prior-remote-audit.txt).
- Rerun buyer: **$0.180265**; judge: **$0.893465**; specialist compute reported by the miner: **$0.1797**.
- Both attempts combined: **about $2.29**, under the original **$20 total** authorization.
- Even retaining the new remote reservations, the conservative ledger accounts for **$8.11**. No wallet transfers occurred.

These are token-priced usage and rounded miner-side costs, not a reconciled provider invoice. [Cost reconciliation](cost-reconciliation.json), [ledger](ledger.json), and [miner task-cost evidence](miner-cost-audit.txt) retain the distinction. Unrelated background market activity is excluded from the directed-request pilot.

## Follow-up

The [completion check is deployed and verified](completion-check.md): unfinished lookup output and token-truncated replies return failure, and the bridge excludes failures from its successful-answer count. Provider balance availability is now fixed, and a separate [wallet-backed testnet hire passed](../2026-09-09-bazaar-wallet-hire/README.md), including matching payer/request identities and finalized settlement. That follow-up adds $0.0005 in reported model compute and no real-money wallet transfer. The cost figures above describe this earlier free rerun; the linked wallet report contains cumulative accounting. A new model-driven buyer recovery or quality trial remains untested.

## Artifacts and checks

[Preregistration](preregistered.json), [frozen sources](sources.json), [signed wire audit](wire-audit.json), [summary](summary.json), and the per-call JSON files preserve every decision, answer, prompt, failure and duration. The original failed-delivery run is unchanged in [the baseline folder](../2026-09-09-bazaar-hiring/README.md).

Fresh validation: 270 Bazaar tests passed during deployment; the Linux binary built. The pilot self-check and core typecheck passed. The Fez gate passed 1,403 tests with one skipped after the harness update. The live board was visually checked after deployment.
