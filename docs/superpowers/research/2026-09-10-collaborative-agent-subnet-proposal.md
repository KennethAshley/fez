# Fez collaborative-agent subnet — proposal

Status: coordination miners selected by Ken on 2026-09-10. The implementation details below are proposals, not an implemented incentive mechanism. The selected direction and first benchmark contract are recorded in [the coordination-miner design](../specs/2026-09-10-coordination-miners-design.md).

## Agreed direction

Make better outcomes through collaboration the subnet's objective. Different agents can contribute different model strengths, tools, knowledge, and context. Reward independently evaluated results, and collect consented handoffs, corrections, and decisions to improve future orchestration. Quality and capability lead; cost and time describe constraints and trade-offs.

This refines the earlier [payment and subnet review](2026-09-10-payment-readiness-and-subnet-direction.md): the goal is broader than reducing the cost of repository tasks. Writing, coding, and work combining several capabilities belong in the initial evaluation. The payment-readiness findings in that review still stand.

## 1. What the subnet offers

A customer can give the existing app's `@fez` an outcome to achieve. In the proposed mature flow, `@fez` is the lead: it decides whether to work itself, ask a specialist, ask several specialists independently, request a revision, or stop. Agents communicate and deliver artifacts through Fez. The lead is responsible for coordinating the final result. Other agents can also serve as leads; `@fez` is the default app entry point, not an exclusive network coordinator.

Example: turn a technical feature request into a working change and a clear guide for its users. A lead might ask a coder for the implementation, a writer for the guide, and a reviewer to check that the guide matches the actual behavior. It can return a review finding to the coder without asking the customer to coordinate the exchange. That is one possible strategy, not a required pipeline.

The product is reliable completion across different capabilities. The research output is evidence about which choices, handoffs, and corrections improved that completion. Evaluated coordination strategies and a future trained model can improve the existing `@fez`, as well as other independently runnable Fez agents. The communication protocol remains usable without that model or this subnet. A benchmark winner is a candidate for adoption, not an automatic production update.

### The app already has a conversational @fez

The desktop onboarding builder creates `@fez` as an ordinary persona on the selected harness/model. Its instructions cover answering questions, choosing workspace specialists, market discovery, free Bazaar asks, and human-approved paid-hire proposals. It is distinct from the separate, simpler `@fezchat/orchestrator` routing service. The earlier proposal treated that routing service as the main product baseline; the desktop persona is the better baseline for this design. [Persona builder](../../../packages/fez-desktop/src/welcome-core.ts:87)

The app also has local orchestration records for proposals, acceptance/decline, selected agent, sent task, delivery/latency, and payment when recorded. The proposal card opens a prefilled hire conversation; accepting the card is not the same as paying or accepting a delivered result. These records are a useful seed, but do not yet establish independently graded final quality or a complete nested handoff episode. In particular, the renderer currently supplies an empty roster to the card, so a roster field in the record type does not prove the candidate context is captured. [Local records](../../../packages/fez-desktop/src/orchestration.ts:14), [proposal card](../../../packages/fez-desktop/src/HireProposalCard.tsx:18), [renderer](../../../packages/fez-desktop/src/App.tsx:3722)

Keep the user-facing flow direct: user → `@fez` → specialists → `@fez` → result. Miners' experimental leads run in evaluation; their measured improvements can become optional `@fez` configurations or trained behavior. This avoids requiring every user task to pass through an additional remote coordinator. It does not authorize automatic spending, sharing private tasks with miners, or exporting local records.

## 2. What miners supply

Treat these as overlapping roles, not permanent agent classes:

| Role | Meaning |
| --- | --- |
| `@fez` | The app's conversational agent and proposed default lead for coordinating a user's outcome |
| Lead | The agent responsible for coordinating one complete attempt |
| Specialist | An agent contributing a capability to a particular task; it may coordinate its own subtasks |
| Miner | A registered participant whose submitted work is evaluated for subnet rewards |
| Validator | The evaluator of that submitted work under declared task and resource rules |

An agent can be a specialist on one task and a lead on another. Being useful through Fez does not require mining. Ken selected coordination as the first miner reward target. The alternative models below remain comparison context.

| Candidate | Advantage | Limitation | Recommendation |
| --- | --- | --- | --- |
| A lead agent that can recruit specialists | Measures the full orchestration decision and assigns responsibility for the result | Requires controlled execution and observation of delegated work | Start here |
| Individual specialists only | Fits today's worker marketplace | Mainly measures specialist ability, with orchestration supplied elsewhere | Keep as the service market supporting leads |
| A fixed complete team | Easy to understand and reproduce | Encourages fixed pipelines and makes team membership part of the entry requirement | Allow as a strategy inside a lead, not a separate miner class |

For the first evaluated track, a miner submits a versioned lead-agent configuration or runnable implementation: a candidate coordination strategy that could improve `@fez`. A validator-controlled environment runs it with recorded resource access. The lead can discover and call a published roster of Fez specialists. The runnable format is an implementation decision to settle against the existing miner/runtime interfaces; this proposal does not introduce a new package format. Miners need not fine-tune a model to enter; configurations and executable policies can establish whether the capability is measurable before a weights-training track exists.

One attempt has one responsible lead miner. Its evaluated final outcome determines its miner score. Specialists earn their quoted service payment or pilot service credit. A specialist need not register on the subnet solely to accept a Fez hire. The same operator may separately run a lead and specialist, but self-hiring does not earn an extra benchmark reward or count as independent demand.

This recommendation has a real trade-off: it directly rewards better coordination, while specialist supply needs service revenue or an explicit evaluation budget. Credits are only accounting; an operator must still fund the underlying inference and tools. If the immediate objective instead becomes expanding specialist supply, the alternative is to keep `@fez` as the reference coordinator and score specialist miners on comparable assigned subtasks. That reuses more of today's Bazaar and produces collaboration traces, but explores less variation in coordination policy. Running both reward tracks initially would require explicit budgets, comparable evaluations, and attribution rules; defer that until one track has useful measured results. This proposal does not change existing Bazaar payouts.

Avoid a new algorithm allocating emissions across every conversational turn. Contribution cannot be inferred reliably from message count, and a lead can manufacture extra identities. Later experiments can estimate a specialist's contribution by controlled replacement or removal; that is not needed for initial payout attribution.

## 3. How validators evaluate quality

Each task has acceptance requirements and a rubric fixed before any attempt. Technical requirements can use protected checks. Writing and synthesis require explicit audience, factual, completeness, and style criteria, with blinded assessment. A passing test suite does not certify good prose; fluent prose does not establish factual accuracy.

Use three task families from the beginning:

| Family | Example | Outcome evidence |
| --- | --- | --- |
| Coding | Implement a requested behavior in an existing repository | Withheld behavioral checks, preservation of existing behavior, review of the delivered change |
| Writing and synthesis | Produce a useful explanation for a specified audience from a supplied source pack | Source-grounded facts, required points, clear structure, blinded reader assessment |
| Combined capabilities | Deliver a working change plus an accurate user guide | Both technical and writing acceptance, plus consistency between implementation and guide |

An initial measurement pack can contain six independent tasks per family. Eighteen tasks establish whether the evaluation and handoff recording work and expose obvious patterns; they do not establish broad superiority. Repeat trials and expand task coverage before making a general claim.

Compare three approaches on the same evaluation tasks:

1. A strong individual agent selected using separate development tasks.
2. A simple specialist-routing or fixed-workflow baseline, also fixed using development tasks.
3. A miner's adaptive lead agent, choosing its own collaboration strategy.

Include the current desktop `@fez` configuration as a named reference in the appropriate baseline and record its real tools and human approval requirements. Do not present the separate lightweight router as equivalent to the conversational app persona. Evaluation may supply a preauthorized test allowance so all compared leads have the same execution permissions; it must count remaining human interventions explicitly.

Use the same allowed model inventory, tools, inputs, budget tier, and deadline per comparison. A single agent may inspect its work, use tools, and revise; do not cripple it to make collaboration appear useful. The fixed-workflow baseline has access to the same specialist roster. Count all delegated calls against the attempt's resource allowance. Record model/configuration versions and specialist availability.

Judge final artifacts without showing miner identity, model brand, staking balance, or number of collaborators. Run objective acceptance first. For subjective evaluation, blind pairwise ordering, check evaluator agreement, and audit a sample with humans. An unavailable judge produces no grade. Publish unresolved disagreements rather than manufacturing certainty.

For a first scoring policy, normalize each task's stated outcome rubric to a common scale, enforce its acceptance/resource rules, then average within each family with equal family weight. This makes category coverage explicit and prevents one easy family from dominating through volume. Exact rubric anchors and eligibility rules belong in the task pack, where they can be reviewed before reward-bearing runs.

Do not give a bonus for delegation, extra messages, number of agents, or spending. A strong direct solution can win. Measure collaboration's improvement relative to both baselines as a separate reported result, including cases where it made things worse. More expensive but better work is a valid outcome inside the declared budget tier; do not automatically collapse quality into a quality-per-dollar score.

## 4. What makes the training data useful

A graded worker response is not yet a record of orchestration. A useful episode includes:

- The initial task, acceptance criteria, allowed capabilities, and candidate roster visible when decisions were made.
- Each directed subtask: sender, recipient, parent task, requested output, relevant context, constraints, and artifact versions.
- Responses and artifacts, verification actions, revisions, failed or refused calls, and the lead's eventual completion or stop decision.
- Brief explicit decision reasons where provided, never an assumption that private internal model reasoning is available.
- The final independent assessment, measured resource use, elapsed time, and any human intervention.

Link the episode with signed event identifiers and artifact hashes. Record observations from the evaluation environment; signatures establish authorship, not truthfulness, full visibility of hidden work, or successful payment. An unverifiable or incomplete episode should not be advertised as a fully observed training example.

Store failures and unnecessary handoffs as well as successes. They can teach when to stop, choose another agent, or work directly. Do not label a particular handoff causally beneficial just because its team succeeded; matched baseline runs and targeted removal/replacement experiments provide stronger evidence.

Use explicitly designated benchmark work for the initial corpus. Private/direct customer hires remain excluded from automatic export. Any later customer contribution requires explicit permission for the task and included material. Separate training, development, and held-out task families, repositories, and source packs. Freeze evaluations before training; keep future test material unavailable to competing agents.

## 5. Why Fez matters

The proposed advantage is collaboration across independently operated agents: different models, knowledge, tools, and contexts meeting through a shared protocol. To demonstrate this advantage, the evaluation must eventually include agents run by different operators and models outside one fixed provider stack. Several personas backed by one model do not establish that result.

Fez's signed identities, directed asks, progress/result events, and artifact delivery are useful foundations. The hard addition is a verifiable connection between the lead's decisions, child tasks, specialist outputs, and final assessment. The earliest controlled roster keeps comparisons interpretable; later roster/version changes can test whether a policy generalizes to unfamiliar specialists.

Provider outages and roster changes need predeclared treatment. Validator infrastructure failure invalidates a run. A specialist's observable refusal or unavailability can be part of a resilience task, but should not silently turn an ordinary quality comparison into a different test. Use isolated attempts so public benchmark traffic cannot reveal another competitor's answer before scoring closes; export approved episodes afterward.

## 6. Reputation, payments, and alpha

Maintain separate histories for specialist work and lead orchestration. Completing one team task does not give every participant the same expertise grade. Outcome attestations should name the task family, responsible actor, evaluator, evidence, and sample size. Customer endorsements and controlled validator assessments should remain distinguishable.

Stake is a separate participation or collateral signal. A properly enforced service bond can support larger outstanding obligations. It must not buy a better writing, coding, or orchestration grade. Native stake balances alone do not establish a refundable service guarantee.

Customer payments compensate useful work. Settlement fees can support operations, reserves, and an explicitly assigned alpha-purchase allocation. Subnet emissions support the scored miner activity through the existing chain reward mechanism. These are distinct flows; do not count internal specialist transfers repeatedly as new outside demand.

The initial benchmark can use controlled accounting and non-monetary service credits. Payment hardening identified in the prior review is required before exposing strangers to real-money autonomous settlement, but need not prevent a consented, bounded evaluation of collaboration quality. This proposal authorizes no model spending, transfers, registration, or production reward changes by itself.

## 7. Fit with the existing implementation

The current Bazaar collector groups progress by the final responding miner's author key. That does not capture a nested graph of independent specialists. Its trajectory hash binds those selected turns and the final result; the exporter fetches only that miner's progress/results and excludes directed hires. Those choices remain useful for the existing worker benchmark, but the proposed orchestration episode is a different evaluation unit. [Branches](/Users/ken/Projects/Fez/fez-bazaar/src/protocol/branches.ts), [collector](/Users/ken/Projects/Fez/fez-bazaar/src/validator/collect.ts), [hash](/Users/ken/Projects/Fez/fez-bazaar/src/protocol/trajectory.ts), [exporter](/Users/ken/Projects/Fez/fez-bazaar/src/corpus/export.ts)

Reuse the current directed-ask and wait behavior for child work and recovery. Extend the Bazaar evaluation/recording path to associate child tasks and their artifacts with one benchmark attempt. Protocol additions, if required, belong in the authoritative event-kind registry and normal client implementation; this document does not allocate new kinds. [Directed asks](/Users/ken/Projects/Fez/fez-bazaar/src/bridge/ask.ts)

The separate workspace routing service selects an agent and forwards the original request; it can be another simple reference policy. The desktop's conversational `@fez`, its hire tools, and local orchestration records are the closer product integration point. Evaluate candidate leads separately and adopt improvements deliberately into that existing app persona. [Routing service](../../../packages/fez-orchestrator/src/route-logic.ts), [desktop persona](../../../packages/fez-desktop/src/welcome-core.ts:87), [local records](../../../packages/fez-desktop/src/orchestration.ts:14)

## 8. Smallest next deliverable

Write the first benchmark task pack: six tasks in each of the three families, explicit acceptance rubrics, baseline configurations, and the required handoff record. Review the pack for tasks unfairly selected to favor collaboration and for evaluation leakage. This produces something concrete to assess before paying for an experimental run or changing subnet rewards.

The decision criterion is improved, independently measured outcome quality or capability on unseen tasks, with reliability, time, and total cost reported alongside it. If adaptive collaboration does not beat simpler alternatives, keep the useful specialists and communication infrastructure, and revise the orchestration strategy rather than rewarding longer conversations.
