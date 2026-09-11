# Coordination transport rehearsal implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. The tasks below depend on one another; no parallel agents are needed.

**Goal:** Exercise direct and delegated C01 artifact delivery over real Fez events, including non-delivery, with bounded local waits and an auditable episode.

**Architecture:** Reuse `CapabilityClient`, `Agent`, and `startRelay`. Add generic task-wait controls and requested-author filtering to the existing client; add optional bind-host/listening notification to the existing relay. The experimental runner uses explicitly scripted, trusted workers and a private ephemeral relay. It never calls a model or labels scripted work as a candidate evaluation.

**Spec:** [Coordination miners](../specs/2026-09-10-coordination-miners-design.md), [development pack](../../../dev/experiments/coordination/TASKS.md).

## Scope and limits

- Existing task/progress/result kinds; no new protocol kind or dependency.
- Relay binds `127.0.0.1` on an OS-assigned port; only ephemeral participant keys may publish rehearsal events. Keys are never written or printed.
- The client accepts task results/progress only from the requested signer with the matching task/recipient tags.
- `timeoutMs` and `signal` bound the local wait and clean up subscriptions; they do not cancel remote computation. The existing agent runtime does not implement remote task cancellation.
- Scripted workers use the public C01 reference repair to test transport. This is not a miner submission, model benchmark, sandbox, or the native @fez host.
- Output records signed task lineage, delivery evidence, content hashes, observed wait time and zero model calls. Quality/acceptance assessments remain absent until an independent evaluation exists.
- No model/provider invocation, market message, wallet operation, chain write, or private record import. All writes go into a new explicitly selected output directory.

## Task 1: Bound and authenticate the existing task wait

**Files:** `src/protocol/client.ts`, `packages/fez-relay/src/relay.ts`, `packages/fez-evals/tests/task-client.test.ts`.

**Interfaces:** Add optional `timeoutMs?: number` and `signal?: AbortSignal` to `TaskOptions`. Preserve the existing 60-second default. Add optional `host?: string` and `onListening?: (port: number) => void` to relay options; default listening behavior is unchanged.

- [x] Add real-wire tests for a forged result followed by the expected signer's result, bounded timeout, abort, progress, and publish refusal.
- [x] Confirm the forged-result test fails against the existing client.
- [x] Subscribe before publishing, filter by expected author/kind/task/recipient, validate the result envelope, and settle once. Centralize timer/listener/subscription cleanup in the same method.
- [x] Add optional loopback binding and a listening callback around the existing HTTP server's listen call.
- [x] Run the targeted tests and root typecheck.

The result check must enforce this conjunction, not trust signature validity alone:

```typescript
event.pubkey === options.to && event.kind === KIND_AGENT_RESULT &&
event.tags.some(t => t[0] === "e" && t[1] === signed.id) &&
event.tags.some(t => t[0] === "p" && t[1] === this.pubkey)
```

Timeout and abort must reject the pending wait, remove its subscription and detach the abort listener; late replies cannot settle it again. Already-aborted calls publish nothing. Nonpositive/non-integer timeout values are rejected before publication.

## Task 2: Exercise and record the complete local handoff

**Files:** `dev/experiments/coordination/rehearsal.ts`, `dev/experiments/coordination/run-rehearsal.ts`, `packages/fez-evals/tests/coordination-rehearsal.test.ts`.

**Interface:** `runRehearsal(directory: string, mode: "direct" | "delegated" | "missing-delivery", packDirectory: string)` returns the same JSON episode written into the fresh output directory.

- [x] Test direct and delegated delivery, parent/child event links, unchanged artifact hashes, non-delivery, and refusal to overwrite existing output.
- [x] Prepare C01 with the existing preparation command; load the trusted reference only in the scripted worker controller.
- [x] Create fresh buyer/lead/specialist identities and the private relay. Explicitly provide generated keys to Agent so its auto-key logging branch never runs.
- [x] Send buyer → lead through CapabilityClient. In delegated modes, send lead → specialist with `parentTaskId` and return the specialist artifact through the lead's root result. In missing-delivery mode, preserve the child result but omit the root reply so the wait expires.
- [x] Observe accepted relay events with monotonic receipt times; retain signed evidence and artifact hashes. Validate returned file names and the exact known fixture content before writing or running trusted checks.
- [x] Record no assessment or candidate quality. Close clients, agents and the relay on every exit; bound the executable CLI process lifetime as a final rehearsal safeguard.
- [x] Run the focused client/rehearsal/pack/scorer tests.

The key distinction in the recorded result is:

```text
specialist returned correct reference + no root delivery => delivered: false
root result carries exact reference artifact => delivered: true
neither path => independently graded quality (assessment remains null)
```

## Task 3: Verify the runnable artifact and document the remaining boundary

**Files:** Update `dev/experiments/coordination/README.md`, `TASKS.md`; record verification here.

- [x] Run the actual CLI with a fresh directory and inspect its saved episode and signed task/result chain.
- [x] Run `npm run evals`, root `npx tsc --noEmit`, and an explicit strict typecheck of the experiment and new test files.
- [x] Explain how to reproduce the rehearsal and identify scripted output. State that live model isolation, provider accounting, blinded assessments and native @fez integration are still required for the real comparison.
- [x] Review only this change; leave unrelated work intact and keep changes local unless integration is requested.

## Execution evidence — 2026-09-10

- The forged-result regression failed against the previous client: the buyer received the stranger's result. The shared fix passed all five client checks. Tests cover expected-author progress, malformed results, local timeout, pre/in-flight abort, invalid limits and publish refusal.
- All three scripted transport cases passed over the real local relay. Saved events have valid signatures, parent/child links and monotonic receipt offsets. Delivered artifact bytes match the public reference; existing output directories are preserved.
- Actual bundled CLI output: `/private/tmp/fez-coordination-rehearsal.BmWQIC`. Direct delivery took 12 ms; delegated delivery took 25 ms; deliberately missing delivery timed out at 5,003 ms. These are one-off scripted transport waits, excluding setup/checks, and establish no model performance or delegation advantage. All episodes have zero model calls, unknown total cost and null quality assessment.
- Full `npm run evals`: **1,513 passed, one skipped; 162 test files passed, one skipped**, exit 0. Log: `/private/tmp/fez-coordination-rehearsal-evals-20260910.log`.
- Root `npx tsc --noEmit` and an explicit strict typecheck of all four experiment TypeScript files and four related test files passed. The executable uses existing esbuild and ws; no dependencies were added.
- Self-review confirmed only the planned files were changed in this stage. Existing edits in the agent, desktop, mining and protocol relay work remain untouched. No commit, deployment, market action, model call or wallet operation was performed.

Completed scope: local transport rehearsal and shared task-client correctness. Remaining: model/tool isolation, funded matched model runs, provider accounting, independent acceptance/quality assessment, and native desktop @fez integration. Scripted fixture success is not full C01 acceptance and never becomes a scorer success row.
