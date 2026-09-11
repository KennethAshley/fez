# Coordination model artifact pilot

> **For agentic workers:** Use superpowers:executing-plans inline. This extends the selected coordination-miner design; keep unrelated work and the current branch intact.

**Goal:** Run one public task through individual, fixed-workflow and adaptive coordinator instructions with real model HTTP calls, signed Fez handoffs, complete usage observations and reviewable returned files.

**Architecture:** Reuse the tested Agent/CapabilityClient/relay lifecycle through one local-team helper shared with the scripted rehearsal. Models return JSON actions: delegate to a named specialist or submit allowlisted artifact text. The controller owns credentials, files, call limits and timeouts. Generated code is never executed by this pilot.

**Spec:** [Selected coordination-miner design](../specs/2026-09-10-coordination-miners-design.md).

## Boundaries

- This is an artifact-generation pilot, not the complete tool-enabled benchmark or native desktop @fez. No code test capability is advertised. Missing execution and independent assessment remain explicit.
- First task is C01 by default; task selection may use any public pack case. The same task, lead model, roster, total call allowance and output allowance apply to all three arms. The fixed workflow is enforced by the host; the individual arm cannot delegate. Adaptive instructions are supplied as a validated Markdown file.
- One explicitly selected OpenAI-compatible endpoint supplies a lead and coder/writer/researcher/reviewer model. Different roles may use different models. No model autodiscovery or credential-store access.
- The execution command requires `--run`. Without it, validate and freeze the comparison conditions and show the maximum request/output allowances without network calls. Credentials come only from `FEZ_COORDINATION_API_KEY`, are never included in output, and are sent only to the configured endpoint. HTTPS is required except literal loopback HTTP; redirects are refused.
- Enforce positive bounded call count, request byte count, output token request and attempt duration. Count specialist and lead calls together. These are resource controls, not a provider billing guarantee. Save usage as reported; missing/malformed usage makes total cost unknown. Declared token prices produce estimates only, never invoices.
- Save returned artifacts under fixed allowlisted filenames in a fresh directory. Do not overwrite the prepared inputs, import returned code, interpret commands, or run model-supplied tests. No assessor/quality/acceptance value is fabricated.
- Record raw model response text, usage, configured/reported model, errors, signed task lineage, exact candidate/pack/configuration hashes and timestamps. Preserve failed arms and continue the matched schedule. No chain writes, wallet operations or public relay messages.

## Task 1 — bounded model requests and a real Fez team

**Files:** `dev/experiments/coordination/model-pilot.ts`, `local-team.ts`, update `rehearsal.ts`; `packages/fez-evals/tests/coordination-model-pilot.test.ts`.

**Interface:**

```typescript
runModelPilot(directory: string, config: PilotConfig, candidate: Uint8Array, packDirectory: string): Promise<PilotReport>
```

- [x] Write an HTTP fixture server test that supplies a direct submission, forced coder/reviewer work, and an adaptive handoff. Assert delivered artifact bytes, roles, signed parent links, common conditions and summed usage; a dropped result must not become success.
- [x] Verify the new test fails before implementation.
- [x] Extract only the common local-team lifecycle and admission policy from the rehearsal. Keep its three existing behavior checks passing.
- [x] Implement a validated configuration, immutable candidate/pack identities, bounded HTTP completion calls and JSON action validation. Reject extra filenames, arbitrary actions, redirects and invalid configuration before any model request.
- [x] Implement individual, fixed-workflow and adaptive arms. Account for every attempted lead/specialist call; retain HTTP/malformed/timeout failures with null unknown measurements. Stop at the common allowance and retain failed output records.
- [x] Verify using a controlled local HTTP server, including missing usage, invalid action, call exhaustion, abort and refusal to overwrite an output directory. No real model is invoked by regression tests.

## Task 2 — executable preview, evidence and verification

**Files:** `run-model-pilot.ts`, `README.md`, `TASKS.md`, selected design progress; update this record.

```text
run-model-pilot <config.json> <candidate.md> <new-output-directory> [--run]
```

- [x] Implement preview as the default. Save the complete frozen conditions and a request/output allowance summary; do not contact the endpoint. Require a new directory for execution.
- [x] Run the actual compiled command against the controlled local HTTP server and inspect its saved report and artifacts. Mark test evidence as simulated model responses, never real inference.
- [x] Run focused checks, root and explicit TypeScript checks, then the full Fez eval gate. Inspect the diff for unrelated changes and credentials.
- [x] Document the exact run command, required provider/model configuration, interpretation of cost, and ungraded status. Record remaining live-run inputs and the absence of code isolation before asking for any funded execution approval.

The next live comparison needs a selected provider/model roster and an authorized allowance. Code execution and independent assessment are separate remaining capabilities; this pilot must not claim that local HTTP test responses demonstrate model quality or a delegation benefit.

## Execution evidence — 2026-09-10

- Implemented `model-pilot.ts`, a 311-line artifact-generation runner, plus its small CLI and a shared 84-line local-team lifecycle. The existing scripted rehearsal now uses the same admission and connection code. No dependencies or production app behavior were added.
- The missing pilot first failed its regression suite. Additional failures reproduced the missing individual revision action, unreported model mismatch and exceeded output allowance; all are now covered. The shared-team refactor's advertised task-type mismatch was also reproduced and corrected.
- **45 focused tests passed** across scorer, pack, client, rehearsal and model pilot. New checks cover HTTP/Fez integration, every task family, shared limits, revisions, unknown costs, unsafe filenames, oversized input/output, redirect refusal, provider/model errors, token-limit violations and timeouts. Test credentials do not appear in saved reports.
- Root `npx tsc --noEmit` and explicit strict checks of every coordination TypeScript file and related tests passed.
- Final full `npm run evals`: **1,529 tests passed, one skipped; 163 files passed, one skipped**, exit 0. Log: `/private/tmp/fez-model-pilot-evals-final-20260910.log`.
- Actual bundled CLI verification: `/private/tmp/fez-model-pilot.dSKcHe`. Both default previews made zero HTTP requests to the local fixture. Explicit execution made seven simulated requests: individual 1, fixed workflow 3, adaptive 3. Every arm delivered the expected files with valid signed event evidence. Costs and quality remained null. These were simulated responses, not real inference.
- A network-free Chutes preview is saved at `/private/tmp/fez-model-pilot.dSKcHe/chutes-preview/preview.json`. The proposed C01 configuration permits at most 18 requests total, 73,728 requested output tokens total, 64,000 request bytes per call and 180 seconds per arm. Those are resource controls, not a provider dollar cap. Published model IDs/rates were checked on Chutes' pricing page on this date.
- Code review confirmed returned model code/tests are never executed, reference repairs/reviewer notes are absent from provider requests, only fixed artifact filenames are written, and credentials are outside evidence. Existing unrelated workspace changes remain untouched. No commit, deployment, wallet operation, provider key modification, or paid inference was performed.

Completed scope: previewable/executable model artifact pilot, tested using local simulated responses. Still required for a real quality benchmark: authorized inference with available credentials, isolated code execution, independent assessment, repeated/counterbalanced trials and the full matched schedule. The native @fez host remains a separate integration.

## First authorized live attempt — 2026-09-10

- The user supplied a Chutes credential for the reviewed pilot. Live catalog IDs and rates matched the frozen configuration. The credential was used transiently and omitted from saved evidence.
- Three inference requests were attempted (one per arm); all returned HTTP 402 before any completion or reported usage. An authenticated read-only account check returned a negative balance and no active subscription, consistent with the payment rejection. No account funding or settings changes were made.
- Report and diagnostic evidence: `/private/tmp/fez-chutes-live.qfXWfe/results.md`. All 23 recorded event signatures verify; each arm remains failed with empty artifacts and null cost, checks and assessment. `complete: true` records the completed attempt schedule, not successful model work.
- No implementation changed during this attempt; the earlier test evidence remains the latest code verification. Next required external change is available Chutes billing, followed by a fresh run under the same frozen conditions. Isolated execution and independent grading remain outstanding.

## Funded retry — 2026-09-10

- After the user confirmed funding, the same frozen conditions and candidate hashes were retried. Live model IDs and prices still matched; all three inference requests returned HTTP 200.
- Individual delivered files in 8.081 s ($0.001534 estimated token cost). Fixed workflow stopped on Markdown-fenced JSON from its coder after 21.791 s ($0.005251), before reviewer or lead synthesis. Adaptive chose direct submission but returned malformed JSON after 5.579 s ($0.001333). Total estimated token cost: $0.008118; no full-system cost or invoice claim.
- Every response asserted tests passed despite having no execution tool. No verified acceptance or delegation benefit exists. Format failures are retained without post hoc repairs or reruns under altered conditions.
- Evidence: `/private/tmp/fez-chutes-retry.GU0XOn/results.md`. All 23 event signatures verify, delivered hashes match, and prepared input bytes match the earlier run. All checks and assessments remain null. No implementation changed; no generated code was executed.
- Next: enforce structured responses where supported, freeze the changed configuration, and repeat the pilot. Isolated test execution and independent assessment remain required before quality scoring.

## JSON mode repair plan — 2026-09-10

The saved failures originated at the model-output/JSON-parser boundary: HTTP succeeded, but prompt-only formatting produced fenced or malformed JSON. Chutes documents `response_format: {"type":"json_object"}` and the selected model catalog advertises JSON mode. Enable that shared wire option; keep existing host action, filename, role and limit validation. This is syntax enforcement, not a guarantee of a particular schema, truthful claims or correct code. No fence stripping, response repair, new dependency, model switch or additional retry loop.

- [x] Reproduce the missing wire/preview setting and preserve explicit JSON-failure evidence with local HTTP regression tests. Three expected failures reproduced before the fix; all 47 focused cases and root/explicit TypeScript checks passed after it.
- [x] Add the response format to every request and hashed preview conditions; verify focused evals, strict TypeScript and the full eval gate. Version 2 changes only `version` and `responseFormat` in conditions. Full gate: 1,531 passed, one skipped; 163 files passed, one skipped. Log: `/private/tmp/fez-json-mode-evals.log`. No dependencies added.
- [x] Run one new three-arm pilot within the existing 18-request allowance, preserve its distinct conditions hash, and report delivery, usage, time and observed limitations.

JSON-mode live evidence: `/private/tmp/fez-chutes-json-mode.STCUFl/results.md`. Conditions hash `9b01047a8bf82321b9038a14297af1291b187d954132736b41c3c508819fbac2`; only version/response format changed. Five model calls returned valid JSON; all three arms delivered. Solo: 6.981 s/$0.001577; fixed: 72.585 s/$0.015430; adaptive: 10.784 s/$0.001830. Total $0.018837 is an estimated model-token cost, not an invoice or full-system total.

Fixed workflow completed two specialist handoffs. Its coder, reviewer and final lead retained the same implementation/test bytes and unsupported test-pass assertion. Adaptive did not delegate and explicitly reported no execution, but its prose misnamed the null-prototype object as a Set. All 25 event signatures and artifact hashes verify; prepared input bytes and candidate instructions are unchanged. No generated code was executed, and all checks/assessments remain null. Next required capability: isolated test execution with host-issued results, then independent grading and repeated task comparisons.

## Saved-code verification extension — 2026-09-10

The user authorized testing the three saved solutions. Add `code-checks.ts`, a small CLI, and `coordination-code-checks.test.ts`. Reuse the public pack and saved artifact hashes. No model calls or changes to the original pilot evidence.

Use the available macOS `sandbox-exec` with a deny-default profile and Apple's dyld startup rules. Permit read-only fixture/runtime access; deny network, writes, process creation and other default-denied services. Clear inherited environment; bound each process to five seconds, 64 KiB output per stream and a 64 MiB V8 heap. This is a local tool for reviewed fixtures, not a VM or a hard total-memory limit. Fail before model-code execution unless trusted isolation, broken-starter and reference controls behave as expected.

Run unchanged acceptance bytes against each repair, plus submitted regression bytes against repair and starter. Preserve exit/signal, bounded output, timing, hashes and TAP summary as process observations. Require actual nonzero test counts; timeouts, output floods, zero-test exits or absent summaries are unavailable. Keep full acceptance/quality null: same-process code can interfere with Node's reporter, so these observations alone cannot judge hostile miners or authorize rewards.

- [x] Reproduce missing functionality; cover real red/green checks, denied OS operations, cleared credentials, timeout/output/zero-test cases and tampered inputs. The missing module failed first. The initial integration control reproduced Node's added `NODE_TEST_WORKER_ID`; allowing that runtime marker retained the explicit inherited-environment allowlist. All 55 focused tests pass.
- [x] Implement exclusive new output, regular-file/hash checks, isolation controls, observed results and CLI; run focused checks, TypeScript and full evals. Root/explicit strict TypeScript passed. Full gate: 1,539 passed, one skipped; 164 files passed, one skipped. Log: `/private/tmp/fez-code-checks-evals.log`.
- [x] Verify the existing JSON-mode pilot, review results and document the next mixed-skill experiment. The actual compiled CLI exited 0. All three repairs passed 3/3 public acceptance tests; submitted regressions failed on starter and passed on repair (solo 3, fixed 2, adaptive 2 tests). All 12 sandbox jobs' input hashes and the unchanged source report hash verify. Evidence: `/private/tmp/fez-code-verified.YEpalE/results.md`. No model calls were made. Full acceptance/quality remain null; later execution cannot substantiate the earlier solo/fixed test-run claims. Next experiment: X01 code plus operator writing, with separate code checks and blinded prose review.

## X01 code and operator-note pilot — 2026-09-10

- [x] Reuse the existing runner with only task ID/family changed from C01 to X01. Live catalog IDs, JSON-mode support and prices matched. Conditions: `f671bdf9ccc0fcd5e48760fa788f63386dcb1025f495439902b10a30cf18da11`. The original six-call/180-second allowance per arm was unchanged; four requests cost $0.021651 estimated model tokens.
- [x] Preserve every outcome. Solo delivered in 18.076 s/$0.001974. Fixed workflow completed the coder handoff but stopped at a writer response lacking the expected visible answer after 132.943 s/$0.017973; no reviewer or lead synthesis occurred. Adaptive delivered directly in 5.692 s/$0.001704. The provider-level cause of the writer failure is not established by saved evidence.
- [x] Review anonymous artifacts before code execution, then run the existing sandbox verifier. Both delivered repairs passed 3/3 public checks; regressions demonstrated the defect (solo starter 4/5 failures to repair 5/5 passes; adaptive starter 2/3 failures to repair 3/3 passes). Controls passed; all 25 signatures, six artifact hashes, nine sandbox jobs and unchanged source report verify. The verifier's exit 2 reflects the undelivered fixed arm, not a failed sandbox control.
- [x] Save a separate provisional combined assessment. Solo's note passed; adaptive's unsupported attribution of a credit to the importer needs correction. Labels hid workflow/model/cost/time, but this was the same assistant's review, not independent grading. Original pilot and code-check assessments remain null. No aggregate benchmark score or reward output was generated.

Evidence: `/private/tmp/fez-x01-pilot.xk7stI/results.md`. No implementation changed, so the preceding TypeScript and full eval results remain the latest implementation checks. X01 is not independent of C01 and supplies no general coordination advantage. Next: reproduce the writer response-contract failure; freeze any correction separately before further matched runs. Independent grading and repeated complementary-skill cases remain outstanding.

## Writer diagnosis — 2026-09-10

- [x] Replay the original writer HTTP request with bounded, sanitized response instrumentation. It reproduced `content: null`, normal stop and 1,925 reasoning-only completion tokens. No relay was involved in this live reproduction.
- [x] Change one request field per control: thinking disabled restored visible JSON but returned a forbidden `revise` action; JSON mode removed and temperature changed to 1 each exhausted 4,096 tokens entirely in reasoning. Four calls cost $0.040712 estimated model tokens. No complete fix or sole JSON-mode cause was established.
- [x] Replay sanitized envelopes through the actual runner with simulated provider responses. All missing-content cases reproduced the original rejection and loss of stop reason; instant mode reproduced the specialist-action rejection. Private reasoning was excluded. Original X01 evidence is unchanged.

Diagnosis: `/private/tmp/fez-writer-diagnosis.is8Loe/diagnosis.md`. No implementation or permanent inference configuration changed. Next repair to validate: explicit writer mode plus submit-only specialist instructions; record bounded stop/response metadata before rejecting content. A successful writer replay and focused regression verification should precede a freshly frozen matched benchmark.

## Writer request repair — 2026-09-10

- [x] Reproduce mode validation, inappropriate role action exposure, and lost stop/reasoning-token metadata through the existing HTTP/Fez regression seam. Five expected failures occurred before implementation; the resulting 21-test model-pilot suite passes. Private reasoning remains excluded and null-content responses remain rejected.
- [x] Add optional boolean `thinking` per model, mapped to its provider chat-template option; omit it for other models. Configure the Chutes writer with `thinking: false`. Give specialists only submit instructions, reserve revision/delegation instructions for eligible leads, and include all role policies/settings in version-3 conditions. Record stop reason before content validation and bounded reported reasoning-token counts. No dependencies or retry/fallback loop added.
- [x] Run root and explicit strict TypeScript checks and the complete eval gate. Initial full run had one existing file-watcher timing failure; it passed in isolation, then the unchanged full run passed: 1,542 tests and 164 files passed, one skipped each. Logs: `/private/tmp/fez-writer-fix-evals.log`, `/private/tmp/fez-writer-fix-relay-watch.log`, `/private/tmp/fez-writer-fix-evals-confirm.log`.
- [x] Verify one real writer call through the changed runner with the archived coder draft and simulated other model replies. Kimi returned submit, normal stop and zero reasoning tokens; 18.931 s and $0.004281 estimated model cost. Signed handoffs delivered its artifacts to the simulated lead. All three files matched the coder's draft exactly; this proves the response/submission path, not added writing quality. No new full comparison or grading was performed.

Evidence: `/private/tmp/fez-writer-fix.pmHKj0/results.md`. Validation conditions: `b1ff3223589d7839409e1c9a1577d0ac081b525bb151fd9ea835186af3ceefd7`. Prior benchmark evidence is unchanged. Next: freshly freeze and run all three X01 arms with live models, then code checks and independent writing assessment.

## Full X01 version-3 trial — 2026-09-10

- [x] Verify the preview matches the repaired settings and live model catalog. Run all three arms without simulated replies, within the original 18-request allowance. Only three calls were made: solo 17.090 s/$0.001769; fixed 127.971 s/$0.014342; adaptive 4.496 s/$0.001886. Total $0.017997 estimated model tokens.
- [x] Preserve the fixed failure: GLM returned normal HTTP but a length stop at 4,096 output tokens, including 3,680 reasoning tokens. No successful coder result was delivered, and writer/reviewer/lead synthesis were not called. No retry or post-generation repair.
- [x] Review masked artifacts before execution, then run the existing code verifier. Both delivered repairs passed 3/3 public checks; each regression passed 4/4 on repair and failed 3/4 on starter. Both notes passed provisional source/format review. Adaptive did not delegate. Same-assistant review remains a limitation; independent grading is outstanding.
- [x] Verify 23 event signatures, six artifact hashes, nine sandbox jobs, frozen preview and unchanged prepared inputs/original report. Keep original assessments null and save separate provisional judgments. No implementation changed, so the preceding TypeScript and full eval evidence remains current for the runner.

Evidence: `/private/tmp/fez-x01-v3.wU0Tuz/results.md`. Conditions remain `b1ff3223589d7839409e1c9a1577d0ac081b525bb151fd9ea835186af3ceefd7`. No delegation advantage is established. Next selected case: X06 delivery-status repair and operator recovery runbook, with unchanged model settings and budgets, to cover a different scenario without tuning away the X01 failure. Independent grading and repeated representative tasks remain required.

## Full X06 version-3 trial — 2026-09-10

- [x] Freeze X06 before outputs, preserving X01 model settings and budgets. Six live calls, no simulated replies or retries: solo 5.064 s/$0.001583; fixed 108.396 s/$0.020688; adaptive 7.420 s/$0.001475. Total $0.023746 estimated model tokens. All approaches delivered within limits; fixed completed coder, writer, reviewer and lead; adaptive worked alone.
- [x] Save label-masked artifact judgments before unmasking and code execution. All code passed 3/3 public checks; every regression passed 3/3 on repair and failed 3/3 on starter. Solo and adaptive passed provisional writing review. Fixed failed the material source-fidelity requirement: its blanket push-recovery instruction also covers failed commits and cleanup-only failures. Same-assistant review is not independent grading.
- [x] Trace saved visible artifacts after review. The coder introduced the instruction. The writer copied the runbook unchanged, the reviewer kept the instruction through minor wording edits, and the lead copied every reviewer artifact unchanged. No post-generation repair changed the submissions.
- [x] Verify 27 event signatures and signer-recipient bindings, nine artifact hashes, all 12 sandbox jobs and their report bindings, frozen preview, unchanged runner/inputs/original report, and estimated token costs. Keep original assessments null and preserve separate provisional judgments. No implementation changed; the preceding TypeScript and full eval results remain the latest runner checks.

Evidence: `/private/tmp/fez-x06-v3.un3UL2/results.md`. Conditions: `03dc5938c63714fed27455a1e4e1cce34aad3d7ccc2fbcb7bc48a0f4bb971c0b`. Successful handoffs did not improve this result; no general or causal ranking follows from one public fixture. Next: independent review of the existing anonymous submissions before prompt tuning or expanded comparisons. Repeated representative tasks and separate trusted execution remain outstanding.

## X06 separate-model review — 2026-09-10

- [x] Freeze three anonymous reviews using Gemma 4 31B Turbo, a model family absent from the generation team. Supply one submission per fresh context with only public task/rubric/source files; omit prior judgments, other submissions, workflow/model labels and generation measurements. Verify catalog support and prices before inference. Cap requests at three, with no retries or fallback judges.
- [x] Preserve every output. All three HTTP-200 responses completed and passed envelope/schema checks. Gemma accepted every submission with all rubric anchors 1 and no findings. Total review time 55.934 s; estimated model-token cost $0.000884. Generation plus review cost $0.024630, excluding operator/local verification costs.
- [x] Compare after all judgments finish. Solo/adaptive agree with the earlier review; fixed workflow disagrees. Mark fixed acceptance disputed, preserve both original judgments, and record the exact source/answer passage for adjudication. No consensus or authoritative judge was predefined, so no authoritative acceptance or reward score is emitted.
- [x] Verify frozen request/conditions/model/usage, isolated packet contents and unchanged original inputs/reports/assessments. Preserve sanitized outputs and the one-off script without credentials or raw reasoning. No production implementation changed or code tests rerun in this review-only stage.

Evidence: `/private/tmp/fez-x06-independent.N7fVtI/results.md`. Review conditions: `8db697f65ff2bfe2570dfbc251999722a3e3385facae7aca0173fb7198375176`. Independence is a separate model and inference context, not a separate human or infrastructure operator. Next: calibrate the evaluator with explicit source-derived correct/incorrect controls and define acceptance/dispute handling before further candidate comparisons. Do not tune prompts to retroactively change this outcome.

## Real repository task selection — 2026-09-10

- [x] Trace the existing hire-delivery helper, actual caller, integration tests and package README. The recovery test bypasses the helper with a direct push. A local bare-remote reproduction confirms that the same helper cannot resume after push rejection: its unconditional commit fails on the clean retained checkout. Existing tests pass 4/4; root TypeScript passes.
- [x] Define [R01](../../../dev/experiments/coordination/REPOSITORY-TASK.md): repair delivery-only retry and submit a source/test/README patch. Freeze observable Git-state and documentation checklists, require a demonstrated regression, and assign unresolved prose disputes to a human maintainer. Preserve X06's earlier disputed assessment.
- [x] Capture exact baseline overlays against commit `b2ca1c2203f96b476e9a409ebdc307d1202a6905`. Select only the existing hire-delivery integration for the agent overlay, excluding unrelated working-tree conversation changes. Freeze task, manifest and reproduction hashes in `/private/tmp/fez-repository-task.j9JgKF/contract.json`.

No production implementation or model inference occurred. R01 shares X06's scenario and is outside the original 18-case schedule. Next: prepare and validate isolated repository execution; the artifact-only runner needs actual repository tools before this comparison can run. Freeze runtime/model/budget conditions separately after that preflight.

## R01 workspace preparation — 2026-09-10

- [x] Reconstruct the frozen base plus overlays in a separate repository, excluding unrelated working-tree changes. Record local snapshot commit `b42c74dc2a79e8d910e26bde60c009f890def161`. Copy installed dependencies without a network install; preserve only links within the reconstructed checkout.
- [x] Validate the baseline: full build of core + 43 packages, root/ACP TypeScript, and full eval gate with 1,395 passed and one skipped. These counts describe the pinned source baseline. All build-generated CLI link targets resolve after the build.
- [x] Prepare solo, fixed-workflow and adaptive copies with separate Git directories/branches, no remote or object alternates, identical snapshot and dependency-lock fingerprints. Each passes four original delivery tests and ACP TypeScript and reproduces the retained-commit retry failure with its own helper. All copies remain clean; the original source checkout is unchanged.

Evidence and checkout paths: `/private/tmp/fez-r01-workspaces.zz6pbp/results.md`. No candidate model ran. The copies separate working state but do not provide an OS sandbox. Next: controlled repository tools and a separate acceptance evaluator, followed by frozen runtime/model/budget conditions before the live comparison.
## R01 repository tools — 2026-09-10

- [x] Add one bounded repository-tool module: tracked source listing/reading, prior-hash writes limited to the three task files, named delivery-test/ACP-type checks. Record exact inputs, bounded outputs and errors outside candidate-write access. Check processes have read-only checkout access, isolated Git scratch data, cleared environment and denied network/host/evaluator/sibling access.
- [x] Connect it to the existing model/Fez runner for both lead and specialist turns. Preserve the shared call/time/cost accounting and artifact-mode behavior. Repository delivery signs final source hashes and saves complete files and a Git diff, including final source from failed attempts. Add an optional `--repositories` CLI argument; preview remains inference-free.
- [x] Verify the actual prepared checkouts: all three pass four original delivery tests plus ACP types under the new sandbox, retaining unchanged sources. Confirm host/evaluator/sibling file denial, child-process inheritance, environment clearing, network denial, output bounds and cancellation. Local HTTP fixtures exercise real read/write tools and signed specialist handoffs without provider calls.
- [ ] Implement and calibrate the external C1–C8 acceptance evaluator, prove the submitted regression against the baseline, and prepare D1–D8 documentation assessment. Freeze the funded run's complete models/tools/dependency fingerprints and resource allowance before inference.

Evidence: `/private/tmp/fez-r01-tools.Ri51JL/results.md`. This stage verifies the repository workflow; it does not repair the baseline, run live candidates, establish acceptance or demonstrate delegation benefit. The R01 task contract and previous X06 dispute remain unchanged. Local macOS sandboxing is not a hostile-miner VM or a hard aggregate process/memory limit.

Verification outcome for the tool stage: 35 focused tests plus root/explicit strict TypeScript passed. The final full gate passed 1,565 tests, skipped one and failed one newly added Polls GUI test on a non-file URL. That unrelated test was edited while the run was active; no GUI file was changed here. Preserve this limitation rather than claiming a green whole-repository gate.

## R01 independent code evaluator — 2026-09-10

- [x] Reuse the repository sandbox for evaluator-owned read-only test/helper overrides, inaccessible from model tool requests. Persist parsed test reports, source/override hashes, process observations and runtime fingerprints.
- [x] Implement the frozen C1–C8 Git-state checks. Calibrate against the baseline, known repair, unsafe branch/force-push/cached-auth and error-leak variants. Correct a calibration assumption: local Git transport strips HTTP configuration before remote hooks, so C8 observes effective configuration at local Git invocation. Extra authorization calls alone are not treated as a failure; each push must use fresh authorization.
- [x] Check unchanged original coverage, submitted tests, an assertion failure on the same baseline test list, and ACP types. Preserve unavailable results for missing/skipped/invalid reports. Create frozen source/test/README review packets for scope, C3-specific regression coverage and D1–D8. Overall acceptance stays null pending that review.
- [x] Connect the existing verifier CLI to saved R01 pilots, validating signed root delivery and artifact/checkout hashes before code execution. A clearly labeled synthetic repair control passed this entire path; no live model or benchmark result is claimed.
- [x] Run the full eval gate: 1,601 passed and one skipped, including the formerly failing GUI-permission suite. Verify root and explicit strict TypeScript plus focused coordination checks.
- [ ] Freeze the funded R01 models, prices, tooling/dependency fingerprints, shared limits, monetary allowance and execution order; run all three live arms; review the saved artifacts without changing the frozen criteria.

Evidence: `/private/tmp/fez-r01-evaluator.vL6w74/results.md`. The baseline and three live-attempt checkouts remain unmodified. The private positive control lives in a separate copy. Code under test shares the test process, so these checks are not a hostile-miner attestation and cannot support rewards without stronger execution/evaluation boundaries.

## R01 first live comparison — 2026-09-10

- [x] Freeze models, prices, tool/dependency identities, 24-call/8,192-output-token/128,000-byte/600-second shared limits, $12 total allowance and solo → fixed → adaptive order. Explicit source-payload approval obtained before inference.
- [x] Run all three live attempts once, without operator changes or retries. Solo and adaptive exhausted calls; fixed coder exhausted output on reasoning with no final answer. No completed submission existed for documentation assessment.
- [x] Verify 23 signatures, 50 tool observations, all 51 usage-based costs, frozen inputs/dependencies and unchanged baseline/shared source. Diagnostic evaluation rejects solo’s unsubmitted draft (only C6 passes; TypeScript fails). Total estimated model-token cost: $0.396462.
- [ ] Diagnose repeated-tool behavior and GLM empty completion from the captured requests; verify a small complete repository interaction before freezing another matched comparison.

Evidence: `/private/tmp/fez-r01-live.7lIKQ2/results.md`. No accepted result, successful delegation, general model ranking or causal coordination benefit is established. Funding is not exhausted; increase limits only after a verified interaction demonstrates useful work being cut short.

## R01 failure-trace review — 2026-09-10

- [x] Replay all recorded responses through the real runner and source-only disposable checkouts; reproduce all failures twice with all 51 request bodies matching except fresh handoff identifiers. Minimize repeated-tool and empty-answer triggers.
- [x] Audit every feedback prefix and read/write hash; rule out dropped tool results and failed write persistence for these traces. Verify all three workflows deliver scripted read/edit/submit controls.
- [x] Separate confirmed GLM output exhaustion from unproven causes of DeepSeek looping. Record flat conversation framing, no budget/progress visibility, and repeated starting sources as interface concerns. No paid calls or implementation changes.
- [ ] Test one conversation-representation variable on a small captured lead case; separately test a supported GLM output/reasoning configuration. Preserve the original benchmark; verify a complete repository interaction before rerunning it.

Evidence: `/private/tmp/fez-r01-traces.wNaiHC/diagnosis.md`. Offline response replay cannot establish that a prompt or model-setting change fixes live inference.


## R01 feedback-format diagnostic — 2026-09-10

- [x] Freeze a six-call/$0.50 same-model probe resuming adaptive call 6; verify an exact flat request, lossless chronological transformation, independent baseline copies, unchanged prices and a scripted real-tool read/write/submit control.
- [x] Run each format once for three continuations. Flat repeats the helper three times; chronological reads README, tsconfig and tests. No edits, checks, delegation or submission. Six live calls cost $0.032040; R01 generation plus this probe totals $0.428502 estimated token charges.
- [x] Verify all request histories, costs, source/manifest identities, dependency copies and unchanged original R01 evidence. Preserve the frozen metric: two first tool observations in chronological, but only tsconfig was absent from the complete starting context. No production changes or new acceptance claim.
- [ ] Verify one tiny complete live read/edit/check/submit interaction before promoting chronological framing or rerunning all three arms. GLM output/reasoning exhaustion remains a separate unresolved diagnosis.

Evidence: `/private/tmp/fez-r01-format.BYjtOh/results.md`. One three-turn pair changes observed behavior but cannot establish a causal improvement or coordination advantage.


## Tiny complete repository interaction — 2026-09-10

- [x] Define a cleanup-warning task and freeze an independent acceptance oracle. Baseline fails the missing-branch assertion; reference passes 4/4. Synthetic real-tool read/write/check/submit control passes, with no paid calls.
- [x] Freeze same DeepSeek lead, chronological feedback, minimal fresh task context, eight-call/8,192-output-token/64,000-byte/180-second bounds and $0.50 allowance within existing $12 authorization.
- [x] Complete one live attempt: two reads, two writes, delivery-tests and types, then submission. Seven calls, 29.069 seconds, $0.013885 estimated model tokens. No retries or operator intervention.
- [x] Accept the tiny task after independent 4/4 oracle, submitted regression failure on baseline, successful observed ACP types and local diff review. Verify all histories/costs/source hashes/dependencies and unchanged baseline/shared source. R01 plus both diagnostics totals $0.442387 estimated tokens.
- [x] Carry the interaction into full R01 under frozen limits; attempts below remain unaccepted. Keep GLM reasoning/output exhaustion as a separate unresolved fixed-workflow diagnosis.

Evidence: `/private/tmp/fez-tiny-loop.M5ICC1/results.md`. This demonstrates one completed small repository interaction; it does not demonstrate R01 correctness, repeatability, signed transport in this probe, or a causal coordination benefit.


## Full R01 interaction and alternate-lead diagnostics — 2026-09-10

- [x] Reuse signed Fez transport with chronological feedback, on-demand source and explicit limits; freeze the original R01 task, baseline, DeepSeek lead and 24-call/600-second limits. Synthetic signed workflow and baseline/reference C1–C8 controls pass.
- [x] Preserve the failed DeepSeek attempt: 18 no-op writes, 24 calls, 119.810 seconds, $0.116296. Separate two-call thinking-switch probe costs $0.016484; explicit thinking yields empty final output at the 8,192-token cap, with unavailable reasoning subtotal.
- [x] Freeze and run Kimi K2.6 with thinking disabled through the same full-task interaction. Its helper passes C1–C8 and types, and the primary retry regression distinguishes baseline, but candidate suite is 9/10, README remains unchanged, and no signed successful submission exists. Nineteen calls/498.616 seconds/$0.189759; stop caused by request byte limit.
- [x] Reproduce the rejected 129,653-byte request offline. A compact-check-feedback prototype reduces it to 94,499 bytes, preserving 36 assertion records and 10 failures plus raw evidence. Verify source, signatures, histories, costs and dependency locks. No production change or live continuation after compaction.
- [x] Integrate compact check feedback in a throwaway diagnostic runner and verify the retained failure path with real tests and signed delivery. Subsequent separately frozen continuations below remain unaccepted; no production runner change or coordination claim.

Evidence: `/private/tmp/fez-r01-loop.3MpqWf/results.md`, `/private/tmp/fez-r01-kimi.AlHH9T/results.md`. This turn costs $0.322539; cumulative R01 and diagnostics $0.764926 estimated model tokens within the unchanged $12 authorization.


## Assisted R01 continuations — 2026-09-10

- [x] Freeze a retained-history continuation with compact assertions: 12-call/600-second/128,000-byte limits, original Kimi configuration, $1.50 planning allowance inside $12. The model makes one fixture edit and two unchanged writes, then hits the byte cap after 6 calls, 224.309 seconds and $0.125390. Preserve the 133,080-byte rejected request and all raw test output.
- [x] Freeze a current-source checkpoint with the same limits and model: seed current three files/hashes and latest complete failure; omit obsolete history and supply no solution. Synthetic real-tool/signed-delivery controls pass. Live attempt uses 12 calls, 52.625 seconds, $0.129032 on reads/listing only. Caller appears in call 7; absence of search is not a sufficient explanation.
- [x] Independently evaluate and verify both saved artifacts: C1–C8 and ACP types pass, original coverage preserved, candidate tests 9/10, README unchanged, no signed success or model review. Check histories, costs, signatures, parents and dependency locks. Combined Kimi effort is 37 calls/775.550 seconds/$0.444181, with no accepted R01 delivery. Cumulative R01 diagnostics: $1.019348 estimated tokens.
- [ ] Establish a task-completing baseline using the existing Fez coding harness and ordinary coding tools. Verify integration offline before spending on a newly frozen comparison. Preserve the restricted JSON-runner failures; do not silently raise their caps or reclassify assisted continuations.

Evidence: `/private/tmp/fez-r01-resume.DQDj0P/results.md`, `/private/tmp/fez-r01-checkpoint.GlaGQ0/results.md`. No production helper/runner edits or additional active paid runs. Full R01 acceptance and the fair three-arm comparison remain outstanding.


## Native harness and signed R01 finalization — 2026-09-10

- [x] Verify bundled native pi read/edit/search/check integration, isolated file/network boundaries, compact assertion feedback, secret-free child environment and frozen call/byte/time/money controls. Fresh original-snapshot attempt fails at request-byte cap after 9 calls/457.693 s/$0.133515; preserve broken helper and lack of final delivery.
- [x] Freeze a retained native-context continuation with 8 more calls and 256,000 request bytes. Offline control verifies exact prior history prefix and latest failure. Model fixes Buffer handling and its fixture; candidate 10/10, original 4/4, independent C1–C8, primary baseline regression and ACP types pass. It hits its call cap before the final answer (65.593 s/$0.178751); preserve failed status.
- [x] Freeze one README-only terminal finalization plus one anonymous Gemma review under $0.20 inside the existing $12 approval. Supply operator documentation feedback and saved observations. Kimi submits the integrated three-file patch and answer with verified signatures (49.825 s/$0.007399); same final code acceptance passes. Record assistance and its unsupported specialist attribution; no actual specialist or handoff occurred.
- [x] Save local review before the model judge: D1–D7 pass, D8 fails explicit remote-divergence correction guidance. Gemma returns raw all-pass judgments, but its nonliteral quotations fail the frozen citation validator (28.812 s/$0.001280). Preserve review failure and raw disagreement, leave acceptance unavailable, and prepare an unapplied one-sentence correction for maintainer adjudication. No judge rerolls.
- [ ] Await the maintainer’s D8 interpretation. Preserve the submitted artifact and failed episodes; any correction is a new assisted artifact. Establish reliable grading and a complete native baseline with equal tools/budgets and reserved final submission before another matched three-arm comparison.

Evidence: `/private/tmp/fez-r01-pi.gJNDtE/results.md`, `/private/tmp/fez-r01-pi-resume.9d5qpV/results.md`, `/private/tmp/fez-r01-finalize.8j9v5kym/results.md`. The review decision is `/private/tmp/fez-r01-finalize.8j9v5kym/adjudication.md`.

Native chain plus finalization/review: 19 model requests, 601.923 seconds summed active run/review time, $0.320945 estimated model tokens. Cumulative R01 diagnostics: **$1.340293** within $12. Operator pauses/preparation and local independent checks are excluded from that active-time sum and model cost. All source identities, dependency locks, native edits, signed delivery and token-price arithmetic verify. No production helper/runner change, no active paid call, no accepted autonomous full R01 result and no demonstrated coordination benefit.


## Updated alpha priority: complementary capabilities — 2026-09-10

Ken clarified that Fez’s value includes independently built agents combining different models, tools and media capabilities. A single-agent win is not a prerequisite. Preserve earlier benchmark failures; R01 adjudication no longer gates this product demonstration.

- [x] Inspect available media capabilities. Existing ElevenLabs extension supports generated speech; no speech API key is available in this session. Installed macOS speech generation works. Incoming audio/transcription is not yet supported by the generic attachment prompt.
- [x] Complete a local writing-agent → speech-agent → delivered-audio job using real signed Fez tasks/results. Kimi supplies the narration; a distinct speech agent wraps Samantha TTS. Return a 25.23-second MP3 and transcript, verify nine signatures, unchanged input text, tamper rejection, two HTTP artifact downloads, hashes and decoded non-silent audio.
- [x] Record one real model call/$0.000502 estimated cost. Preserve the initial host rejection of an 86-word response against an unnecessary 85-word target. Remove that style gate and reuse the exact saved generation for the completed handoff; no additional model request. This is an assisted fixed-workflow SDK demo on a local relay, not an autonomous desktop run or comparative score.
- [x] Expose the speech specialist to the actual app’s `@fez` and verify an ordinary conversational request completes the same useful job (one enrollment retry; details below). Expand to image/transcription agents once each capability and artifact handoff is available.

Evidence and playable output: [CAPABILITY-DEMO.md](../../../dev/experiments/coordination/CAPABILITY-DEMO.md). Disposable evidence root: `/private/tmp/fez-capabilities.wy3wplx6`. No production app code, installed personas, public relay messages, external media uploads or persistent services changed.


## App speech handoff delivered — 2026-09-10

- [x] Add explicit macOS speech to the existing ElevenLabs MCP extension; retain
  ElevenLabs default, use native WAV output, preserve text limits, return the
  audio URL and correct MIME metadata. Add a real-synthesis regression eval.
- [x] Register the local speech tool and speaker persona. Let the desktop summon
  and enroll the agent through its ordinary roster/attestation path.
- [x] Complete `@fez` script → speaker narration → coordinator delivery. Preserve
  the missed first-start handoff and one operator retry rather than calling this
  fully autonomous. Verify 12.88-second audio, matching hash/size/transcript,
  signed events, and return-path thread links.
- [x] Record 115 seconds initial request → final delivery, 34 seconds after retry.
  Speech API cost is zero; the four agent turns expose no usage/cost figures.
  Both typechecks and speech tests pass. Full eval gate remains 1,654 passed,
  five skipped, one unrelated watcher failure; isolated watcher rerun passes.

Evidence: `/private/tmp/fez-speech-app.aHF4Tp`; current report:
[CAPABILITY-DEMO.md](../../../dev/experiments/coordination/CAPABILITY-DEMO.md).
The local speaker is installed and running. Initial-enrollment request recovery,
threading the voice note itself, and reliable model cost reporting remain limits;
image/transcription capabilities have not been implemented by this change.


## First-handoff recovery fixed and installed — 2026-09-10

- [x] Reproduce missing first work with the actual runtime, NIP-42 and a
  membership-gated relay. Original late-enrollment test fails; enrolled control
  passes. A history read before enrollment is empty and was never revisited.
- [x] Recover startup work once membership is available. Replay the current
  roster to catch enrollment between the initial snapshot and subscription.
  Retain the startup cutoff, answered-request checks and event deduplication.
- [x] Cover enrollment before boot, during boot and after announcement. Full
  gate: 1,658 passed, five skipped. Root/ACP typechecks and runtime builds pass.
- [x] Install the signed local runtime with a backup; stop only speaker, wait
  for its existing presence to expire, and send one new request through @fez.
  The desktop wakes speaker; it backfills the original handoff and delivers
  one audio post and one response in the request thread, with zero resends.

Delivered 19.99-second WAV in 36 seconds from the user request (22 seconds from
specialist handoff). Signatures, exact transcript, hash, byte count and audio
signal verify. Speaker delivered directly to the user; @fez did not post a
separate final wrap-up. Guaranteed coordinator callbacks remain a separate
limitation. No transcription or image capability was added.

Evidence: `/private/tmp/fez-coldstart-app.A6UOan`; logs:
`/private/tmp/fez-startup-red.log`, `/private/tmp/fez-startup-full-evals.log`.
Previous installed binary: `/private/tmp/fez-agent-before-startup-recovery.bin`.

## Completion and acceptance delivered — 2026-09-10

- [x] Mark actual known-specialist assignments in signed channel messages;
  preserve separate submitted result and requester acceptance semantics.
- [x] Add `fez_complete_work` and `fez_accept_work`, using existing channel
  messages and kind-47007 chits. Validate the assigned signer, request, thread,
  channel and terminal status; retain ordinary peer-reply loop protection.
- [x] Suppress duplicate callbacks/tool acknowledgments, review queued results
  separately, and recover the latest 200 terminal results after restart while
  skipping those already answered. Keep larger offline backlogs a stated limit.
- [x] Pass root/ACP/MCP/client types, builds, regression checks, and full gate
  (1,667 passed, five skipped). Install backed-up local binaries and update the
  speaker persona to use structured completion.
- [x] Complete one fresh public app job without a resend: write → speech →
  signed result → coordinator checks → acceptance chit → final user delivery.

Live delivery: 74 seconds, with a 12.09-second WAV and six verified signed
events. Specialist handoff-to-result: 22 seconds. Audio hash/size/decoding,
nonzero signal and supplied transcript preservation verify. Three model turns
report duration but no usage/cost. No paid Chutes call occurred. Acceptance is
the coordinator's recorded judgment, not user approval or independent speech
transcription; existing Salt household exclusions still apply.

Evidence, old executable/persona backups and verifier:
`/private/tmp/fez-completion-app.UWOsB5`.
Full test log: `/private/tmp/fez-completion-full-evals.log`.
