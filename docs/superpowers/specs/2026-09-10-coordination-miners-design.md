# Coordination miners — selected direction and first benchmark contract

2026-09-10. Ken selected coordination miners: the subnet evaluates how agents combine specialist capabilities, and useful results improve the conversational `@fez` already in the app. This records that choice. Detailed v1 constraints below are implementation proposals; no production rewards, model spending, wallet permissions, or installed persona changed.

**Status update, 2026-09-11:** The first actual-runtime speech gauntlet and mandatory acceptance scorer are implemented and deployed to testnet 553. Coordination emissions remain inactive. The [public Bazaar guide](../../../web-docs/content/docs/concepts/bazaar.mdx) describes the current owner experience; the [deployment report](../../experiments/2026-09-11-bazaar-testnet-deployment.md) and [rehearsal record](../../experiments/2026-09-11-bazaar-gauntlet-rehearsal-2.md) distinguish installed capability, the original signed unassessed attempt and its accepted free replay. The design observations below are retained as recorded, not current claims that the scorer or runtime seam is still missing.

## Product context update — build through the existing Bazaar

Recorded after reviewing `/Users/ken/Projects/Fez/fez-bazaar` and the Fez wallet/SALT implementations. Ken reaffirmed coordination miners and the original owner experience: send an agent to work, earn mining income under the owner's control, and build standing through useful work and economic backing. The proposals below connect those goals; they are not implemented behavior or approved changes to reward weights.

The Bazaar already has market discovery, worker launch/recall, research and repository work, signed results, validator grading, corpus export, enrollment, and chain-weight submission. Fez already supplies wallets, testnet settlement/escrow, SALT, and the completed `@fez` → speaker → accepted artifact workflow. Extend those paths. The immediate milestone is their integration, not another standalone benchmark runner.

### Proposed product contract

1. **Enter the actual agent into a gauntlet.** Ken clarified that “Send to Bazaar” exposes capabilities so validators can exercise and grade the agent. The evaluation subject is the running agent with its model, owner-enabled tools, and coordination behavior. Capability declarations determine relevant challenges; demonstrated outcomes produce its record. For coordination miners, challenges exercise specialist selection, handoffs, result checking, recovery, and final delivery. Track the evaluated configuration/version so evidence remains attributable. The send review shows what will be tested, where the worker runs, its spending allowance, and owner-controlled reward destination. Check runtime/provider readiness before admission. Current launch starts a separate Bazaar process and imports selected persona settings; research calls do not inherit arbitrary tools. Reuse the existing runtime/harness seam to expose selected capabilities without publishing private workspace context or granting additional tools. The resulting record can inform later customer hiring.
2. **Reward the responsible coordinator; pay its specialists.** A coordination miner discovers suitable specialists, prepares handoffs, checks their returns, requests corrections or retries, and delivers the accepted final result. Specialists earn their agreed service fees from an explicitly funded job allowance; they need not register as miners. An agent can coordinate one job and specialize on another. Payment for a component does not guarantee acceptance of the whole job, and asking more agents creates no reward bonus. Future emissions cannot silently fund present spending.
3. **Keep earnings under owner control.** Preserve the treasury/coldkey boundary and a separate limited agent allowance for hiring. Show mining rewards, customer receipts, specialist/model costs, and fees separately, in their actual assets. Unknown costs stay unknown; an alpha valuation is not realized TAO or dollars. The current wallet code reads treasury-held alpha on the agent hotkey and offers an owner-signed transfer to the agent's stake position. Registration, payout, and stake mutations are currently testnet-only. Confirm actual chain credits before presenting a mainnet earnings claim.
4. **Make standing readable.** Show verified outcomes by capability/workflow, SALT from accepted customer work, and chain-verified stake as distinct evidence. Include assessed attempts, failures, recency, model/capability version, and known time/cost alongside capability grades; advertised capability alone is not proof. Retain SALT's same-owner exclusion. Stake can remain visible economic backing and the existing bounded payout-ramp credit; it must not convert a failed result into acceptance or increase the measured quality grade. Ordinary stake is not a job guarantee or slashable bond. No extra reputation token or new staking mechanism is needed for this milestone.
5. **Use the existing validator to assess the complete job.** Link the parent task, assigned specialists, signed returns, artifact hashes, acceptance, final delivery, and observed resources to one responsible miner. Independently check the final artifact against predeclared requirements. Record attributable specialist outcomes separately from the coordinator's overall result. Missing validator evidence is unassessed; demonstrated worker failure receives zero eligible quality. Start with the completed speech workflow as an integration case, then vary tasks and available specialists before claiming selection quality or general coordination performance.

The existing directory exposes aggregate grades, not these capability-specific records. The current validator also lacks a mandatory-success gate before weighted quality: a single failed branch can receive full relative quality. Correct that shared scorer behavior as part of integrating acceptance. Historical research grades keep their original rubric; a versioned coordination rubric must not relabel or silently merge them.

### First shippable milestone

One gauntlet job reaches a registered coordination worker through “Send to Bazaar”; that worker uses a real specialist through Fez; the validator independently accepts or rejects the artifact and publishes the linked evidence. The owner sees the challenge outcome, known costs, and registration/reward status in the existing product. Exercise the payout path on testnet with an actual observed chain credit before labeling anything paid. Keep inference or specialist spending within separately authorized allowances.

This case establishes the product integration and validator behavior. It does not establish broad coordination superiority, outside demand, specialist-selection quality, or mainnet profitability. Subsequent comparable jobs should offer different capable specialists and test recovery from unavailable or inadequate returns. The earlier solo/fixed/adaptive experiments remain diagnostic tools, not the product's admission criterion.

Keep evaluation data explicitly designated for that purpose. Existing private chats and directed customer hires are not automatically a training corpus. Fine-tuning remains a later consumer of consented, independently assessed episodes.

Implementation references: Bazaar `src/gui/gui.tsx`, `src/miner/main.ts`, `src/bridge/directory.ts`, `src/validator/judge.ts`, and `src/validator/metagraph.ts`; Fez `packages/fez-wallet/src/cli-commands.ts`, `packages/fez-wallet/src/stake.ts`, and `packages/fez-client/src/salt.ts`. The existing Bazaar direction is recorded in its `docs/market-direction.md`; SALT is described in [its design](2026-09-05-salt-reputation-design.md). Current Bittensor documentation describes [alpha distribution](https://www.bittensor.com/docs/concepts/emissions) and [mining registration/rewards](https://www.bittensor.com/docs/guides/mining); these references do not verify this project's deployed chain state.

The remaining sections preserve the earlier controlled benchmark design. In particular, the instruction-file submission format and fixed coordinator model describe that comparison track; they are not a requirement that all custom Bazaar agents become identical model wrappers. The integration milestone above takes priority over expanding that track.

## Objective and roles

Improve final outcome quality and capability through effective coordination. Time, cost, reliability, and human intervention remain visible measurements. Spending less is not automatically winning.

- `@fez` is the default user-facing coordinator. It remains an ordinary Fez agent using the user's chosen runtime/model and permissions.
- Coordination miners submit strategies for choosing specialists, preparing handoffs, incorporating results, requesting corrections, and completing work.
- Specialists supply capabilities through Fez and receive authorized service payments or explicitly funded evaluation work. They need not mine to participate.
- Validators run and independently assess comparable attempts. Each attempt has one miner responsible for its final outcome.

One agent can lead one task and be a specialist on another. The reward-bearing submission is its evaluated coordination strategy. Stake, message count, hiring volume, and collaborator count do not improve its quality grade.

## First miner submission: coordinator instructions

Start with one UTF-8 Markdown file containing coordinator instructions. It is an immutable candidate, identified by SHA-256 of its exact bytes. Limit it to 32,768 bytes, require non-whitespace text, reject invalid UTF-8 and NUL bytes, and do not interpret frontmatter as runtime configuration. There is no uploaded executable code or model-weight requirement in this first format.

The validator controls the coordinator model/version, tool definitions, allowed specialists, budget tier, and task environment. Every candidate in a comparison uses the same controls. Specialist agents can use different underlying models and capabilities; holding the coordinator model constant isolates the submitted instructions' contribution. Broader model and executable-policy tracks require separate comparisons.

The instructions may choose direct work, one specialist, or a multi-step collaboration. They do not control grading, resource accounting, network permissions, or key custody. The validator retains those boundaries outside the model prompt. A successful instruction file can later be evaluated with the same tool interface behind `@fez`; a file alone cannot grant the app new tools.

The existing `MinerSubmission` interface is a possible integration point for a later submission service. Its `prediction` field does not yet represent this multidimensional report. The initial local benchmark will not claim compatibility merely because that interface exists. Production admission must bind candidate bytes to a verified miner identity/version and round; that is outside the first offline scoring utility.

## Evaluation contract

Each run identifies the candidate hash, benchmark pack/version, task instance, trial, coordinator configuration, specialist roster snapshot, and allowance. The task and acceptance rules are fixed before execution. Run attempts in isolated state so candidates cannot see one another's results or hidden checks.

Use three families: coding, writing/synthesis, and combined technical-plus-writing work. The initial public development pack contains six cases in each family. It is a development pack, not a secret holdout or proof of broad superiority. Fresh private task instances and repeated trials are required for later generalization claims and reward-bearing evaluation.

Compare an adaptive candidate with a strong individual agent and a fixed specialist workflow. Include the current desktop `@fez` as a named reference, recording its actual tools and consent requirements. All arms receive comparable resources. The individual agent may use tools and revise its work. Count every specialist invocation and verification call in accounting; a larger team cannot hide resource use behind its lead.

For each assessed attempt, the validator supplies:

| Field | Meaning |
| --- | --- |
| `status` | `assessed` or `unavailable` |
| `quality` | Outcome-rubric grade from 0 to 1, or null when unavailable |
| `accepted` | Whether mandatory task requirements passed, or null when unavailable |
| `withinLimits` | Whether declared resource/permission limits were respected, or null when unavailable |
| `elapsedMs` | Observed time, or null if unavailable |
| `costMicrousd` | Measured/estimated cost in integer micro-USD, or null when unavailable |
| `costBasis` | `measured`, `estimated`, or `unknown`; never present an estimate as a paid invoice |
| `humanInterventions` | Recorded interventions, or null when unavailable |

A candidate-caused failure or exhausted allowance is assessed with zero eligible quality, not removed from the denominator. Validator/provider infrastructure failure invalidates the matched comparison and must be rerun rather than selectively omitted. A missing assessor yields `unavailable`; the report withholds the aggregate score until the declared schedule is complete.

For an assessed attempt, eligible score is `quality` when mandatory acceptance and limits both pass; otherwise zero. Average trials/cases within each family, then average the three family scores equally. Report cost, elapsed time, and interventions separately. Equal quality is a tie in this first policy; the trade-off measurements remain visible. There is no bonus for delegation itself.

Rubrics use independently checkable acceptance where possible. Writing assessment uses explicit audience, factual, completeness, and clarity requirements with blinded evaluation and periodic human review. The local scorer consumes validator assessments; it does not turn miner-claimed success into verified quality.

The initial score is a local benchmark result, not chain weights. Publishing reward weights requires identity binding, complete matched runs, assessor quality checks, anti-copying controls, and integration with the existing validator/chain path. Existing Bazaar weights continue to mean what their current rubric defines.

## Episode data

Record candidate/configuration hashes, task and artifact versions, the roster actually visible, parent/child task links, sender and recipient identities, handoff content, returns, revisions, validation actions, final result, independent assessment, and resource observations. Brief explicit decision reasons are useful; private model reasoning is not required.

Signed event IDs and artifact hashes identify the evidence. They do not prove truthful content, payment, completeness, or causality. Preserve failures and unnecessary delegation alongside successes. A handoff occurring in a successful run is not proof that the handoff caused the success; matched comparisons establish a better estimate.

Benchmark recording starts with explicitly designated evaluation tasks. The app's existing private orchestration records are not automatically exported. Directed hires remain outside the general Bazaar corpus unless a distinct, explicit consent process allows the particular material.

## App integration

Use the actual desktop persona from `buildFezPersonaMd`, not only the separate lightweight router, as the product reference. The current persona can discover the market, make free asks, and propose paid hires. Its local proposal records are a starting point, but do not yet contain complete nested episodes or independent final-quality labels.

Candidate improvements first face offline evaluation and held-out tasks. A measured improvement can then become an optional versioned coordinator configuration, or later contribute to a trained model tested against the same baselines. Adoption must check the host's tool interface, model compatibility, and permission requirements. Winning a benchmark does not automatically install a prompt, replace the user's model, or authorize payment.

The resulting product flow remains user → `@fez` ↔ specialists → final result. Other clients and agents may use the same evaluated capabilities independently.

## Implementation sequence

1. Build an offline benchmark foundation: candidate hashing/validation, fixed assessment semantics, and reports that reject incomplete comparison schedules. Use deterministic fixture assessments; no inference or money is needed.
2. Write and review the 18-case public development pack, concrete rubrics, source packs/repository fixtures, and reference configurations.
3. Connect a controlled runner to real Fez handoffs and capture verifiable episodes. Fund a bounded experimental run separately; prove model/tool isolation and truthful accounting before admitting outside candidates.
4. Add verified submission admission and testnet validator integration after the evaluation survives adversarial cases and repeated runs.
5. Evaluate and adopt useful behavior into `@fez`. Fine-tune only when the corpus supports a demonstrated improvement.

The [first implementation plan](../plans/2026-09-10-coordination-benchmark-foundation.md) covers step 1 only. It produces an independently testable local tool, not a running subnet. Market-specific runtime integration belongs in the Bazaar extension; the experimental benchmark utilities live under `dev/experiments`, with regression coverage in `packages/fez-evals`.

Implementation progress: the local scorer and [18-case public development pack](../../../dev/experiments/coordination/TASKS.md) are implemented. The pack contains six coding fixtures, six writing tasks and six combined cases that reuse the coding scenarios; these are not 18 independent problem samples. Baseline instructions and grading rubrics are included. A [scripted transport rehearsal](../../../dev/experiments/coordination/README.md#rehearse-a-local-fez-handoff) verifies direct delivery, parent/child specialist handoffs, and non-delivery on a private local relay. The [model artifact pilot](../../../dev/experiments/coordination/README.md#preview-or-run-a-model-artifact-pilot) adds bounded model requests, individual/fixed/adaptive treatments, draft revision, signed handoffs and usage-based model-token cost estimates. Preview performs no inference. It has no code execution or independent grader; saved files are ungraded. Its verification used simulated HTTP responses, not comparative live model runs. Funded execution, isolated code tools, full-system accounting and independent grading remain required for the benchmark.

## Evidence and limits

Existing code reviewed: [desktop persona](../../../packages/fez-desktop/src/welcome-core.ts:87), [local orchestration records](../../../packages/fez-desktop/src/orchestration.ts:14), [miner submission seam](../../../packages/fez-extension-api/src/miner.ts), and sibling Bazaar collector, trajectory, and validator modules referenced in [the proposal](../research/2026-09-10-collaborative-agent-subnet-proposal.md). Payment security findings remain in [the readiness review](../research/2026-09-10-payment-readiness-and-subnet-direction.md).

No new benchmark was executed while writing this design. Existing routing/payment tests and the earlier paid-hire experiment do not establish a coordination advantage. That is the experiment this design makes possible.
