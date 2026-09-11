# Bazaar coordination gauntlet implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement these bounded tasks with independent review.

**Goal:** Connect the first brief → script → spoken deliverable evaluation to Bazaar's existing worker, scorer, signed results, and owner view.

**Architecture:** Correct acceptance in the shared scorer first. An explicitly enabled coordination lane runs the selected Fez persona through its existing harness and attached capabilities in fresh task state; signed Fez specialist evidence connects back to the Bazaar task. The validator checks the fixed requirements and artifact independently before publishing a versioned capability record. Existing research and chain behavior remain separate.

**Tech stack:** Existing TypeScript, Bun tests, Vitest evals, Nostr events, Fez ACP and local speech verification.

**Spec:** ../specs/2026-09-10-coordination-miners-design.md — updated Product context takes precedence over the older benchmark track.

## Constraints

- Preserve all existing uncommitted work; no commits, installs into the running app, paid inference, specialist payments, deployments, or live reward changes in this implementation session.
- Agent configuration is the evaluation subject. Never replace its model or silently grant tools. Never export private histories, memory, persona instructions, or credentials.
- Failure is zero eligible quality; missing validator observations are unassessed. Stake, SALT, capability grades, model costs, service payments, and chain credits remain separate.
- The first fixed speech case verifies integration, not broad selection quality. Native transcription remains explicitly unavailable where its runtime is missing.
- The new lane is opt-in. A local successful test does not constitute a paid job or observed chain reward.

## Tasks

1. [x] **Mandatory acceptance in the existing scorer.** Add failing cases in Bazaar `test/judge.test.ts` for singleton failure, all failures, mixed success/failure and unavailable assessor; implement in `src/validator/judge.ts`, carry acceptance/rubric through `attest.ts`, prove the existing age ramp/weights cannot revive failure. Run focused tests, then the Bazaar suite.
2. [x] **Actual-agent runtime and reviewed admission.** Add generic isolated evaluation request/preflight to Fez ACP with eval coverage. Bazaar preflight invokes that runtime without inference, returning a configuration hash and resolved capabilities. Send review names execution host, allowance and owner-controlled reward status; stale configuration or missing runtime blocks admission.
3. [x] **Connect the speech job and independent assessment.** Reuse signed work completion and existing speech verifier; link Bazaar root, Fez request, script, specialist assignment/return, acceptance and delivery. Use injected transport/runtime/audio observations in tests. Keep unknown resource measurements explicit, require separately authorized service funding, and withhold reward changes for this lane.
4. [x] **Show separate capability evidence and verify.** Extend existing directory/operator rows with versioned workflow records, failures, recency/configuration and known costs. Keep historical research scores separate. Run Bazaar typecheck/tests/build and Fez typecheck/evals, review the patch, document remaining live acceptance prerequisites.

The checks use controlled local runtime/provider boundaries and signed fixtures; they do not call paid services. Each behavior test is written and observed failing before implementation.

## Verification and remaining live acceptance

Implemented in both repositories without committing or replacing existing edits. Bazaar's existing worker, validator, owner panel, directory and public research board share the new admission/acceptance path. The local relay integration test runs the actual Bazaar worker and validator with a fixture agent runtime and a signed specialist response.

- Bazaar: 335 tests pass across 40 files; typecheck and complete worker/validator/extension build pass.
- Fez: 1,727 evals pass, six skipped; root typecheck and the core plus 45-package build pass. An initial file-watcher timing failure passed in isolation and on the full rerun without code changes.
- Review regressions cover unknown spending across midnight, configuration drift, wallet restrictions during evaluation, prepayment before assignment, independently observed speech, and rubric separation in all three Bazaar displays.

Operator setup is documented in the sibling Bazaar README, under “First coordination gauntlet.” A live job still requires separately authorized model/service funding and a speaker already permitted to serve the evaluation channel. Model allowances stop on reported usage and can overshoot within one provider call; unknown costs stop subsequent work. Independent local transcription requires the installed macOS speech model and ffmpeg. The evaluation wallet guard applies to trusted local tools, not hostile executable isolation.

No new paid inference, specialist payment, live gauntlet job, chain-weight submission, deployment, or install into the running app occurred. Actual testnet chain credit remains unobserved for this lane; no mining reward or specialist receipt is labeled verified payment on fixture evidence.
