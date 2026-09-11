# R01 — Recover a completed Fez hire without rerunning its engine

Status: task and acceptance contract frozen on 2026-09-10; no candidate attempt has run. This is a real repository change, with local Git integration tests and package documentation as deliverables. It extends the delivery scenario already explored in X06, so it is not an independent new task family.

## Problem and evidence

`deliverHire` stages, commits, pushes and removes a temporary hire checkout. On failure it preserves the checkout and tells the operator to retry delivery. However, after a successful commit and rejected push, calling this same helper again fails at its unconditional commit because the checkout is clean. The saved commit never reaches the remote.

The existing test named “supports delivery-only recovery” manually calls `git push` for recovery. It does not check that the delivery helper can resume. All four existing tests pass on the starting code; a separate local Git reproduction confirms the retry failure.

The real caller is the one-shot hire path in `packages/fez-acp/src/agent.ts`: it invokes the coding harness before calling `deliverHire`. Restarting that whole hire path would create another checkout and invoke the engine again. There is no delivery-retry CLI in this snapshot. The task must not invent one in its documentation.

Evidence: `/private/tmp/fez-repository-task.j9JgKF/reproduction.json`; runnable reproduction: `node /private/tmp/fez-repository-task.j9JgKF/reproduce.mjs` in the original evidence directory **only before an observation exists**. The script writes its observation exclusively; copy it and its `overlay` directory to a new temporary directory for another run.

## Candidate request

Make the existing `deliverHire` helper support a delivery-only retry from a retained worker checkout after push failure. Preserve its exported name, existing required options and synchronous success/error contract. The caller supplies a valid temporary checkout, the intended branch, and a fresh authorization callback. A clean checkout on that branch may contain completed work that still needs delivery; an empty diff is not, by itself, a delivery failure. The helper does not prove that the engine created new work or that a buyer accepted it.

Return a patch to these three repository files, together with actual test observations:

1. `packages/fez-acp/src/hire-delivery.ts`: implement recovery and preserve the delivery safety properties below.
2. `packages/fez-evals/tests/hire-delivery.test.ts`: exercise real local repositories, including a second invocation of the same helper after a rejected push. Retain the original test coverage.
3. `packages/fez-acp/README.md`: add a concise recovery section for the worker operator/maintainer, grounded in the implemented behavior.

Use the existing dependencies and tests. Keep changes within these files. Do not add a new command, model call, payment flow, automatic retry loop, persistent job system or unrelated refactor. The existing caller remains compatible. The work is complete only when the lead submits the integrated patch and verification record; a specialist's private patch is not delivery.

## Code acceptance, fixed before attempts

The evaluator checks observable Git state, not a candidate's claim that a command succeeded. Each scenario uses an isolated temporary working repository and bare remote; no network service or real credential is needed.

| ID | Starting state / trigger | Required observation |
| --- | --- | --- |
| C1 | Changed files on the intended hire branch | Commit as the persona, push the requested branch, preserve remote `main`, then remove the temporary checkout. Per-command signing overrides work with an otherwise unavailable global signer; global configuration is unchanged. |
| C2 | Commit succeeds; remote rejects push | Throw a sanitized push-stage failure naming the retained checkout and branch. Preserve the completed commit and working directory. Do not expose the authorization header or private remote stderr. |
| C3 | Remove C2's remote rejection; invoke the same helper again with the same checkout/branch | Push the original completed commit and clean up. Remote branch equals the saved commit SHA. Do not create an empty/replacement commit, rewrite history or require another engine run. This is the primary regression. |
| C4 | Commit hook rejects changed work | Preserve staged edits; report a commit-stage failure; do not push. Once the hook is repaired, another helper call commits and delivers that retained work. |
| C5 | Push succeeds; local cleanup fails | Return delivery success with a cleanup warning and retain the directory. Remote branch still points to the delivered commit. From an otherwise unchanged retained checkout, another helper call may perform a harmless up-to-date push and finish cleanup; it must not create another commit. No claim of crash-safe exactly-once execution follows. |
| C6 | Current checkout branch differs from the requested branch, or HEAD is detached | Fail before staging, committing, pushing or removing the checkout. Preserve both working tree and remote. This prevents delivery or cleanup of a different branch's work. |
| C7 | Remote branch has diverged from the retained local commit | Preserve ordinary non-fast-forward protection: fail the push, retain work, and do not force-push, reset or overwrite the remote. |
| C8 | Retry requires another push authorization | Invoke the supplied authorization callback for that push attempt. Do not cache a prior credential or expose it in error/warning output. |

A dirty retained checkout is processed as the helper's normal changed-files path; there is no promise to preserve its old commit SHA after an operator has edited its contents. The C3/C5 unchanged-SHA checks apply to unchanged retained work. Invocations are sequential and the caller has exclusive ownership of this temporary checkout. Concurrent recovery, crash journaling and recovery after the directory has already been deleted are outside this task.

Keep independent evaluator checks outside candidate-write access. The test source the candidate adds is evidence of regression coverage, not authority to weaken this table. A meaningful regression must fail against the frozen baseline and pass against the submitted repair.

## Documentation acceptance, fixed before attempts

The reviewer must cite the relevant README passage for every item. Judge operational instructions and consistency with the submitted code; do not grade preferred prose style.

| ID | The new section must explicitly explain |
| --- | --- |
| D1 | Where to find the retained checkout and branch in the error, that it is on the worker, and that operators should inspect state before recovery. |
| D2 | Commit failure: retain staged work, resolve the commit blocker, then retry the delivery helper. No successful new commit or delivery should be claimed yet. |
| D3 | Push failure after commit: retain the saved commit, resolve remote/grant/authentication problems as applicable, then retry the delivery helper. Unchanged work keeps the same commit. |
| D4 | Cleanup failure after push: delivery succeeded; local cleanup remains. A model rerun or another lease is unnecessary. If describing a repeated helper call, accurately disclose any up-to-date push it performs. |
| D5 | The helper is an internal worker integration. This change adds no public retry command and restarting the complete hire path is not delivery-only recovery. Do not prescribe nonexistent flags or direct users to paste private keys into commands. |
| D6 | Delivery requires a successful push of the intended branch. Commit success and passing tests alone are insufficient; successful push does not prove buyer acceptance of code quality. |
| D7 | Failed delivery preserves work; recovery does not automatically authorize another model run or payment. Signing overrides are per-command, not edits to the operator's global signing settings. |
| D8 | Branch mismatch, detached HEAD and remote divergence require inspection/correction; the helper does not force-overwrite remote work. Its sequential temporary-checkout contract does not promise universal retry idempotency or recovery after deletion. |

An instruction to “push whenever the checkout is preserved,” without restricting it to an appropriate state, fails this contract: a preserved checkout may have uncommitted work or already-delivered work. Correct status descriptions elsewhere do not cancel an operational instruction that contradicts them. This rule applies to R01 prospectively; the earlier X06 dispute is preserved.

## Accepted result and comparison

Acceptance requires C1–C8, D1–D8, a regression demonstrated against the baseline, unchanged original coverage, passing relevant TypeScript checks, and delivery of the complete patch. Each item is pass/fail with a test observation or artifact citation. Do not turn missing evidence into a pass. A documentation disagreement is recorded as unresolved and acceptance stays unavailable until a designated human maintainer adjudicates the cited requirement; do not retry model judges until they agree. This explicitly replaces the earlier ad hoc single-model review for this new task.

Compare the same three approaches: strong solo, fixed coder → writer → reviewer → lead, and adaptive coordination. The lead model, specialist roster, source snapshot, ordinary repository tools and total resource allowance must match. Solo retains full read/edit/test/revision tools and is not deprived of source information. Delegation is optional in adaptive; a model's role label is a hypothesis about capability, not an established ranking. Specialists can help implement the Git behavior, translate it into useful operator guidance, and check their consistency.

Report accepted result, elapsed time, total lead/specialist/retry/verification-model cost, human interventions and actual handoffs. Preserve failed attempts and separate candidate failures from infrastructure failures. Unknown costs remain unknown; token estimates are labeled. A quality gain may justify extra cost or time. Successful messaging or merely hiring a writer earns no credit.

Freeze exact models, sampling, tool versions and permissions, shared limits, price evidence, monetary allowance and execution order in a separate run manifest before inference. Counterbalance order across repeated trials. A single trial is descriptive; an accepted team result alone does not prove delegation caused improvement. The existing artifact-only pilot cannot execute this repository task unchanged: actual isolated repository tools and an external evaluator are prerequisites for running it.

## Starting snapshot and verification

Base commit: `b2ca1c2203f96b476e9a409ebdc307d1202a6905`.

Snapshot manifest: `/private/tmp/fez-repository-task.j9JgKF/baseline.json`. Exact overlays are under its `overlay/` directory. `hire-delivery.ts` and its tests already exist as uncommitted workspace work; they are included explicitly. The `agent.ts` overlay applies only the existing delivery-helper import/call/error-preservation change to the committed file, excluding unrelated conversation changes. This is a declared development snapshot, not an invented historical commit. Do not give candidates the current shared checkout or unrelated working-tree changes.

On 2026-09-10, the current delivery suite passed 4/4 and root `npx tsc --noEmit` passed. The isolated reproduction still failed the second helper invocation at commit, as expected. These checks establish the starting defect; they do not validate a repair or certify the entire reconstructed snapshot. Before releasing attempts, prepare the isolated baseline, build its required artifacts and run its relevant checks; classify unrelated baseline failures before scoring changes.

The task's frozen SHA-256 and evidence hashes are recorded in `/private/tmp/fez-repository-task.j9JgKF/contract.json`. No model calls, production edits, live pushes, payments or candidate scores occurred during task preparation.
