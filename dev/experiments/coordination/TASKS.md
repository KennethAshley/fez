# Coordination development pack v1

Start with **C01: stop duplicate imported payments**. It reproduces the repository used in a recorded agent-to-agent hire. A specialist repaired the code, but the first automatic delivery failed and an operator recovered it. That makes it a useful case for checking both artifact quality and handoff completion.

This pack is ready for local preparation and rubric review. **No full graded comparison exists.** In X06, all three approaches delivered code that passed public checks and demonstrated regressions. Solo and adaptive passed both prose reviews; adaptive worked alone. The assistant rejected the fixed workflow's blanket push-recovery instruction, but a separate Gemma model accepted it. Fixed acceptance is disputed; both judgments remain preserved. Gemma saw one anonymous submission per fresh request without prior judgments or workflow information. Three reviews cost $0.000884 estimated model tokens; generation plus review totals $0.024630. Latest evidence: `/private/tmp/fez-x06-independent.N7fVtI/results.md`; earlier attempts, including X01's output-limit failure, remain recorded separately. The next selected work is R01 below, with explicit state-based acceptance and human dispute handling. Evaluator calibration remains required before model judgments can support rewards. Six coding cases and six combined cases share scenarios, while writing includes several source-synthesis and audience tasks. This is a public development pack with small fixtures, not a hidden test or evidence about general agent capability.

## Next repository task

[R01 — recover a completed hire without rerunning its engine](./REPOSITORY-TASK.md) is the selected next task. It uses the real delivery helper, real local Git remotes, repository tests and package documentation. A push-failure retry through the helper is reproducibly broken despite all four existing tests passing. Code and documentation acceptance are explicit before candidates run. Three repository copies are now prepared and verified: the shared baseline passed the full build, root/ACP types and 1,395 tests with one skipped; each copy passes four delivery tests, ACP types, and reproduces the intended defect. Paths and evidence: `/private/tmp/fez-r01-workspaces.zz6pbp/results.md`. Controlled repository tools are now connected to the existing model/Fez runner. The three checkouts pass their original delivery tests and ACP types inside the restricted test sandbox; local model fixtures verify tool turns and final signed source hashes. Evidence: `/private/tmp/fez-r01-tools.Ri51JL/results.md`. The independent code evaluator is now calibrated: baseline fails four requirements, a known repair passes all eight, and unsafe variants are rejected. It checks original coverage, regression against baseline and types, and binds results to signed submitted files. Final acceptance still requires scope/test/prose review. Evidence: `/private/tmp/fez-r01-evaluator.vL6w74/results.md`. A funded-run manifest and first live R01 comparison remain next. R01 is related to X06's delivery scenario and is not added to the 18-case scorer schedule.

## Prepare the first case

From the Fez repository root, using Node 20 or later:

```sh
coordination_attempt=$(mktemp -d -t fez-coordination)
node dev/experiments/coordination/prepare.mjs C01 "$coordination_attempt/C01"
cat "$coordination_attempt/C01/task.md"
node --test "$coordination_attempt/C01/acceptance.test.mjs"
```

The final command should fail on the starter's duplicate-import bug. That is the expected starting state, not a completed benchmark result. No agent, inference call, payment, Git push or production edit is performed by these commands. The preparation command refuses an existing destination.

Replace `C01` with any ID below to prepare another case. The returned directory contains the public task, relevant source material, a case manifest with SHA-256 hashes, and—for coding/combined work—the broken module and public acceptance checks. Candidates return the requested repaired module, regression tests and `answer.md`. Writing cases return `answer.md`.

Give a candidate only that prepared directory and its controlled tools. The master [development-pack.json](./development-pack.json) also contains reference implementations and reviewer notes; it must not be mounted into a live attempt. `prepare.mjs` copies neither. The supplied checks are public; future held-out checks and tasks must be independently prepared and isolated.

## Cases

| Coding | Combined code + explanation | Shared scenario |
| --- | --- | --- |
| C01 — Stop duplicate imported payments | X01 — Explain the invoice repair to an operator | Recorded synthetic invoice repository |
| C02 — Recognize intentional agent mentions | X02 — Add newcomer mention help | Explicit mentions versus email/path fragments |
| C03 — Fail closed without blocking collaborators | X03 — Explain the access policy | Owner, allowlist and verified siblings |
| C04 — Preserve history after partial failure | X04 — Write a useful support reply | Cached messages and truthful error state |
| C05 — Preserve the full handoff request | X05 — Show a correct delegation payload | Constraints lost in a model summary |
| C06 — Separate code completion from delivery | X06 — Write a recovery runbook | Commit, push and cleanup outcomes |

| Writing | Skill being assessed |
| --- | --- |
| W01 — Explain the failed hire honestly | Evidence-led incident communication, including recovery and uncertainty |
| W02 — Write a first-use guide for @fez | Clear newcomer instructions and accurate consent boundaries |
| W03 — Synthesize a mixed coordination result | Arithmetic, trade-offs and appropriately limited conclusions |
| W04 — Write grounded launch copy | Concise, engaging writing without invented benefits |
| W05 — Choose a specialist for the skill needed | Capability fit, uncertainty and a useful handoff brief |
| W06 — Repair an unsupported data/training pitch | Accurate policy communication and credible tone |

C01/X01 use the original invoice starter from commit `e7445ed934ad33acb6e808f864f8876a670c0321`; the reference repair comes from recovered commit `6746e6e78b126a6f81f6afbb5a8bacbdbd7172f7`. The exported function is unchanged; its fixture filename is `task.mjs`. See the [recorded experiment](../../../docs/experiments/2026-09-09-bazaar-lebron-repo/report.md).

The other five code starters are deliberately broken reconstructions grounded in Fez source and regression cases. They are **not full Fez integration tests or observed historical patches**. Each source contract names its limits. The pack pins provenance file hashes; future edits to the live repository do not silently change these frozen task inputs.

W01 uses a sanitized incident summary. W03's table and W05's roster are explicitly fictional exercises. Product/policy writing uses frozen fact sheets. No customer messages, raw private transcripts, keys or wallet credentials are included. C05 and W04 are intentionally small controls where direct work can succeed; hiring more agents earns no bonus.

## Accepted result and quality

An attempt is accepted only when the required deliverables reach the lead's submitted output and all mandatory task conditions pass. Correct work remaining solely in a specialist's checkout is not a delivered result. For coding and combined cases, the evaluator runs the unchanged public checks against the submitted module and verifies the requested regression artifact. For writing and combined cases, a reader checks factual claims and the requested audience/form against the supplied sources.

Reference implementations validate the fixture/check relationship only. They are not complete candidate submissions: the regression report, writing deliverable, actual handoffs, cost and time still have to be observed. Passing fixture tests alone cannot be used as a complete benchmark assessment.

After acceptance, grade each published rubric dimension at **0, 0.5 or 1**, using its explicit anchors. Multiply by its weight and sum to get `quality` in `[0, 1]`. The task's preparation includes the full rubric so requirements are declared before work begins.

| Family | Quality dimensions |
| --- | --- |
| Coding | Contract coverage 40%; regression evidence 30%; maintainability 30% |
| Writing | Source fidelity 40%; decision usefulness 25%; audience/clarity 25%; format 10% |
| Combined | Code contract coverage 35%; regression evidence 15%; explanation fidelity 30%; user usefulness 20% |

Use two independent readers, blinded to candidate identity, model names, cost and delegation count. Give them the original task, submitted artifacts, source pack, unchanged check results and reviewer notes. Each records gate decisions, dimension grades and a short evidence citation to the artifact/source. If they disagree on a mandatory gate or any dimension, a third blinded reader resolves that disagreement with an evidence note. Average agreed dimension grades; use adjudicated values for disputed dimensions. Do not invent grades when a reader is unavailable.

Word limits count whitespace-separated words in the entire `answer.md`, including headings. Source IDs are enough for citations when a task requests them. A task may earn a better clarity grade without adding length, models or citations it did not need.

The evaluator separately supplies `accepted` and `withinLimits`. A candidate-caused failure, non-delivery or exhausted allowance is assessed and contributes zero eligible quality; it is not omitted. Provider/validator failure is `unavailable` and withholds the affected matched comparison until rerun. A missing assessment is not an accepted result with zero cost.

These local checks execute trusted development fixtures and their reference repairs. They are not a sandbox or an adversarial miner judge: hostile code can interfere with a process that imports it. A live submission runner must independently contain execution, protect its evaluator/evidence and verify results before reward-bearing use.

## Reference configurations

The pack contains three instruction files as exact text plus SHA-256 hashes:

1. **Individual:** completes the work directly, with ordinary local tools and full allowance. The future runner disables delegation; the prompt is not an enforcement boundary.
2. **Fixed workflow:** coding uses coder → reviewer; writing uses researcher → writer → reviewer; combined uses coder → writer → reviewer. The lead integrates and checks the result. No extra specialist repair round is added adaptively.
3. **Desktop @fez snapshot:** exact output of `buildFezPersonaMd("pi")` at pack creation, with no selected provider/model. This is an instruction reference, not a native desktop run. Its frontmatter is retained as literal candidate text, not interpreted to grant tools or change the model.

The fixed and adaptive arms use the same specialist roster. The individual arm retains the same non-delegation tools and full resource allowance. Its deliberate no-delegation policy is recorded as part of the common experimental conditions. A comparison must never cripple the individual arm's ordinary ability to inspect, test or revise.

The supplied execution profile proposes three trials (`0,1,2`), 600 seconds per attempt, 20 total model calls, 24,000 total model tokens, at most two concurrent specialists, and delegation depth one. All lead, specialist, verification-model and retry calls count toward the same attempt totals. These are initial pilot limits to review before execution, not a claim that any task fits them or an authorization to spend.

Before a live run, freeze the exact lead and specialist model/provider versions, sampling, tool definitions, host/adapter versions, environment, prices and an authorized monetary allowance. Logical roles are coder, writer, researcher and reviewer; their underlying models may differ. Keep the lead model constant across compared coordinator instructions. Real resource enforcement belongs in the runner, outside model prompts.

The native `@fez` reference needs its actual host tools and permission behavior. If the experiment substitutes controlled adapters for those tools, label the result **adapted @fez snapshot**, record the adapter and compare only under compatible conditions. Do not silently claim a prompt-only test measured the desktop app.

## Measuring whether delegation helped

Record one complete episode per task/trial/candidate:

- Candidate, pack, configuration and artifact hashes; task ID, scenario cluster and trial.
- Exact roster visible to the lead; parent/child task IDs, sender/recipient, handoff request, returned artifacts, revision requests and final submitted output.
- Acceptance checks and independent rubric evidence. Brief explicit decision reasons are useful; private model reasoning is not required.
- Total lead + specialist + verification cost in micro-USD with measured/estimated/unknown basis, attempt elapsed milliseconds, and human-intervention count. Record the source of each cost observation. Testnet transfers are not converted into a dollar cost without an explicitly declared method.
- Limit compliance and any candidate, provider or evaluator failure. Wall time runs from release of the task to receipt of final artifacts, including specialist waits; unavailable durations remain null.

Feed the existing scorer only complete assessment rows from that process. `case.json` contains a **pack hash**, not a complete `conditionsSha256`; hash the full frozen conditions declaration separately. Build candidate manifests with all 18 task IDs and the same trial set. Never convert an empty preparation into fabricated success rows.

For each matched task/trial, report adaptive eligible quality minus individual eligible quality and minus fixed-workflow eligible quality. Report cost and time differences separately. Include negative differences, ties and non-deliveries. A comparison can show a quality improvement with higher cost; neither spending nor delegation itself is the objective.

Across this public pack, report the scorer's equal-family average descriptively. Also show results by scenario cluster: each C/X pair is related, and W01 shares the invoice incident. Treating all 18 cards as statistically independent would overstate evidence. Three repeated trials do not create three independent task problems.

To attribute benefit to one specialist or handoff, repeat the same candidate with that specialist/handoff removed or replaced under controlled conditions. A successful delegated run alone cannot establish that the collaboration caused success. Fresh private tasks and repositories are required before generalization or reward claims; do not train on this pack and call it a held-out result.

## Verification

```sh
npm test --prefix packages/fez-evals -- tests/coordination-pack.test.ts tests/coordination-benchmark.test.ts
```

The pack checks validate task/source/rubric completeness, prepare all 18 cases, preserve existing attempts, and run every code starter and reference repair against independent acceptance checks. They do not run an agent or grade the prose assignments.

Verified when the pack was added on 2026-09-10: 21 focused coordination checks passed; the full Fez suite passed 1,505 tests with one skipped. Root and explicit experiment/test typechecks passed, as did the preparation script syntax check. Each of the six starters failed its acceptance checks and each reference repair passed. The manually prepared C01 reproduced the duplicate-import failure. No agent execution or prose assessment is included in those pack checks.

The [local transport rehearsal](./README.md#rehearse-a-local-fez-handoff) now runs scripted C01 reference workers over real Fez task/progress/result events. It records direct delivery, delegated delivery, and a completed specialist reply that never reaches the buyer. The exact reference code passes its fixture checks in the delivered cases. This is not a complete C01 attempt: no model produces the repair or required explanation, and acceptance/quality remain ungraded. No scorer rows are produced.

Rehearsal verification on 2026-09-10: all three actual command modes completed as expected; eight new transport/client checks passed; the full suite passed 1,513 tests with one skipped. Root and explicit experiment/test typechecks passed. The [implementation record](../../../docs/superpowers/plans/2026-09-10-coordination-transport-rehearsal.md) contains the evidence paths.

The [model artifact pilot](./README.md#preview-or-run-a-model-artifact-pilot) now runs individual, fixed-workflow and adaptive treatments over a configured model endpoint and this same Fez transport. It captures visible responses, signed handoffs, files and model-token cost estimates. Its fixed workflow matches each task family, and every lead can revise its own draft. Preview makes no provider requests; execution requires an explicit command.

This pilot saves generated code without executing it, so the supplied code tests and prose rubric remain unassessed. It runs one task once per treatment, not the full repeated schedule. Regression and command verification used simulated HTTP responses; no live model quality or delegation benefit was measured. Native `@fez`, isolated code execution, independent assessment and funded repeated comparisons remain separate work.
