# Ridges local runtime verification — 2026-09-10

## Verified

Docker Desktop 4.90.0 / Engine 29.7.2 ran on this Apple Silicon Mac. The actual Mining submission/development React components were served in a temporary browser harness whose command bridge invoked the real built Mining CLI. The CLI launched its detached evaluator worker, which used official Ridges commit `56406a15eccfca8417030e87b9d0ef34cbcd8d5a` with Python 3.12.14 and Harbor 0.20.0.

The GUI saved partial setup, stored a fake runtime-key marker privately, linked a committed candidate, requested confirmation, started evaluation and automatically displayed the persisted result. No wallet enrollment, registration, upload or inference requests occurred. This did not verify native Tauri packaging or chat-agent execution.

## Actual results

1. Unmodified Harbor `hello-world@1.0`: failed after 11.4 seconds because its Ubuntu image lacks `python3`. The panel preserved a failed experiment and accepted no score.
2. Separate `ridges-runtime-smoke` copy: added Python, pip, Git, curl and CA certificates to its Dockerfile. A fixed candidate returned the requested hello-world patch without inference. The official evaluator returned reward **1** in **42.322 seconds**, and the panel refreshed automatically. This is an integration smoke, not competitive coding evidence.

Successful run: `e8d9bda4-c297-41de-8a74-3b72084e4f63`.

- Candidate SHA256: `b6d88fcbaa52ef402652a425158d871b8655253522fa432ae60f998fcfb7d40e`
- Candidate Git commit: `04f987cada32a8dd68977819086af2203381bd26`
- Task digest: `sha256:d6b99cc62f0b3c8735256b9c05f617865c8fbe1ade67cad11f6bd096ff34a218`
- Upstream exposed zero individual test records; reward is the measured result, not a claim that zero tests ran.
- Upstream did not report cost; Fez correctly omitted it.

Temporary evidence is under `/private/tmp/fez-ridges-baseline-20260910/`, with the run record in `home/mining/62-ridges-baseline-20260910/development/`. Temporary files are not durable product configuration.

## Remaining work

A real coding baseline still needs a general coding candidate, a compatible unmodified coding task, and an explicitly approved limited inference key/budget. Do not use the fixed smoke candidate or this reward as evidence of mining competitiveness. The upstream root `agent.py` is a demonstration that reads `/sandbox/solution.diff`, not a suitable general coding baseline.

The panel also showed the existing submission-preflight error for the Mac's test-network wallet while development remained usable. Errors from the evaluator are intentionally generic and raw run logs are discarded; the missing-Python cause required an isolated diagnostic invocation with the fake key. These remain usability limitations, not a verified production onboarding flow.

## Coding baseline prepared after smoke

The user authorized up to **$5** of inference for the first coding baseline. `examples/ridges-local-baseline/` now contains a local-only, two-call candidate with credential-budget checks and bounded source selection/edits. It has not produced a benchmark result yet.

Downloaded the unmodified official `swebench-verified@1.0` task `astropy__astropy-7166`. Its image `swebench/sweb.eval.x86_64.astropy_1776_astropy-7166:latest` resolved to `sha256:4b46c92697326df9440868e8990289755954dd739a1ff27a4ad1371da6a63ce2`. Verified that this x86 image runs locally with Python 3.11.5 and Git 2.34.1 under Harbor's actual `bash -c` shell. A login shell instead activates the task's older Python 3.6 environment; that is not Harbor's runtime shell.

The temporary profile now links `coding-candidate/agent.py` and the downloaded coding task. The smoke credential was removed. The user saved a dedicated, non-resetting OpenRouter key limited to $5. The current key editor does not expose `include_byok_in_limit`; the original UI instruction was incorrect. Verified in the workspace BYOK page that Anthropic is not configured, removed that unnecessary flag requirement, and restricted the candidate to Anthropic with fallbacks disabled. The first coding evaluation has now been launched; its result is pending.


## First measured coding baseline

The completed coding run `63e544d6-9497-4b11-bf0a-28432e7fac84` took **59.111 seconds** and returned **reward 0**, **0 passed / 7 failed / 0 skipped** from the official evaluator. This is a valid unsuccessful coding result, not a runtime failure or evidence of competitiveness.

Two integration failures were diagnosed first: the runner dropped `DOCKER_DEFAULT_PLATFORM` (fixed with a regression test), and unconstrained model output caused `JSONDecodeError` during file selection. The candidate now requests strict provider-supported JSON schemas with required parameter support. No parser retry loop was added.

OpenRouter's dedicated-key usage after all attempts was **$0.238536**, with **$4.761464 remaining** and **$0 BYOK usage**. This is aggregate baseline/debugging spend, not a per-run cost attributed by the evaluator. Raw approved diagnostic artifacts were deleted after retaining the classified cause.

Validation: **1,652 Fez tests passed, 5 skipped**, and root typecheck passed. The measured run's evaluator task digest is `sha256:7d4c698d7e65326b446710fd24c017824ccc1aea3a12f017689937f0971ced3c`.

Candidate SHA256: `c750cec942b128b67f0e69a7c07f86cebe76414e5e3e1368350f2b6024894c02`; candidate commit: `ea0b3b8e914648d413e70027bf46dba5e54d8a7f`.


## Candidate improvement experiments

Source inspection of a privately retained diagnostic patch showed that filename-only selection invented a second class in the wrong module. Added generic symbol search from the issue before file selection. Run `f2eef7d2-b3e8-4db7-beb6-c366a550a031` completed in **52.175 seconds**, with **6 graded tests passed / 1 failed**, reward **0**, on the same task digest and configuration.

Subsequent bounded experiments added a generated Python reproduction, one repair, a requirement that the reproduction fail before the edit, and a separate review of observable behavior. Runs `0a7b116c-b0ba-4e80-b916-a1efd3880ece`, `747788bb-d00b-4028-ac67-3569c100c985`, and `f8f9e8ee-a45a-4f93-bc84-d0570b51c1ec` all remained at **6 passed / 1 failed**, reward **0**. A diagnostic trace showed a patch-shaped test: the candidate checked the getter's docstring instead of the property's public docstring. No reference solution was used or inserted into the miner.

Retained the cheaper two-call source-search candidate from temporary commit `39cf867`; removed the unhelpful check/review machinery from the shipped example. This is measured progress on regression preservation, not a solved coding task or proof of competitiveness. More samples would be required for a robust comparison because generation can vary.

Final dedicated-key totals: **$1.134210 spent**, **$3.865790 remaining**, **$0 BYOK usage**, across all baseline and diagnostic attempts. Raw private diagnostic artifacts were deleted after recording findings. Paid runs stopped here rather than spending the remaining credit on unchanged scores.
