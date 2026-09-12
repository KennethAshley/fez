# Repository delivery fixed and verified on the Air

**LeBron's saved invoice fix was delivered from the Air, and the buyer received its signed success through Bazaar.** This was an operator-initiated retry of delivery only: zero new model calls, zero payments, and no new task. The original paid coding run still required recovery; this is not a fresh unattended full-hire test.

## Changes

- Both repository workers disable commit and push signing only for their own Git commands. The owner's global settings remain unchanged. Pushes still authenticate using the agent's Nostr identity.
- Failed work stays in its checkout. Delivery errors identify the failed Git step and recovery location. Cleanup errors after a successful push are warnings, preserving the successful result.
- Repository progress is limited to one update per five seconds across the miner's concurrent hires. The original trace reached the deployed relay's 60-events-per-minute limit; token-level progress had exhausted the allowance before the failure result.
- The harness adapter parses stdout and stderr separately, accepts final lines without a newline, and requires a clean exit before reporting success. It forwards only the known Git recovery format; legacy command/provider errors remain private.

The reviewed fixes are pushed on `codex/hire-delivery`: [Fez PR #7](https://github.com/KennethAshley/fez/pull/7) and [Bazaar PR #3](https://github.com/KennethAshley/fez-bazaar/pull/3). Both PRs are merged into main. The exact Fez merge tree passed 1,515 tests with one skipped, the full build, and the ACP typecheck; Bazaar passed 301 tests. Unrelated working changes were excluded. See [publication evidence](publication.json). Production files: `packages/fez-acp/src/agent.ts` and the new `hire-delivery.ts` in Fez; `src/miner/main.ts` and `src/miner/repo-work.ts` in fez-bazaar. The updated native runtime and miner are installed on the Air, with [rollback copies recorded here](air-install.json). This is a local installation, not a published Fez release.

## Verification

- Fez gate: **1,429 passed, 1 skipped**. Run serially because existing integration suites share fixed ports.
- Bazaar suite: **301 passed**.
- Root, ACP, and Bazaar typechecks passed; ACP, native runtime, and Bazaar extension builds passed.
- An independent code review found three issues, all corrected with regressions observed failing before the fixes.
- Real Git tests cover unavailable interactive signers, rejected pushes, preserved staged edits/commits, delivery-only recovery, and cleanup failure. Local relay tests cover successful and failed results after a 300-message progress burst.

See [check record](checks.json), [Fez summary](fez-evals-summary.txt), and [Bazaar summary](bazaar-tests-summary.txt).

## Air delivery retry

The retry applied the original saved patch to a fresh checkout and called the same updated delivery helper used by the real agent runtime. It authenticated and signed its result as LeBron. The Air's global `commit.gpgsign` remained `true`; its temporary checkout was removed after the push.

- Branch: `lebron/hire-delivery-retry`
- Commit: `a3d4d6578d156d679d6127039e71012141a6c748`
- Author: `lebron <lebron@fez>`
- Original task: `db0d783276ec26ec7fe17613fa1b76c11d71d711b02bc8dd89b412cbe3df513b`
- Signed result: `2d211d059b924b32ef1428853e2e93fc900001b1edb6be9df28ec24f98ccd3ff`

The existing buyer MCP returned `task_state: answered` and one successful answer for that original task. The fetched files exactly match LeBron's original fix; all **6 repository tests and 10 withheld checks passed**. Protected `main` stayed at the original seed commit.

Artifacts: [portable result bundle](delivered-result.bundle), [Air result](delivery-retry-result.json), [signed event](delivery-retry-event.json), [buyer verification](buyer-verification.json), [code verification](code-verification.json), [tests](delivered-tests.txt), [withheld checks](delivered-holdout.txt). The inspected checkout is `/private/tmp/lebron-invoice-delivered-20260910`.

The temporary repository grant, relay, and Tailscale route are closed. The Air retry process has exited; normal Fez services and user-added SSH access were retained. [Cleanup evidence](cleanup.json).

The subsequent [fresh unattended hire passed](../2026-09-10-bazaar-unattended-hire/report.md): new payment, new task, real engine execution, automatic commit/push, signed buyer receipt, and independent code checks, without operator recovery.
