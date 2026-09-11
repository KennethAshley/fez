# Conversation Isolation Implementation Plan

**Goal:** Each channel thread and document comment thread owns its context,
session, queued messages, retries, and steering. DMs remain participant-scoped.

**Architecture:** Keep the existing single-active-turn runtime and four-session
pool. Reuse `parseThreadRef` for chat roots. Carry document metadata through all
deferred calls. Claim queued work synchronously so delayed dispatch cannot race
new relay events. No new packages, worker pool, or protocol kinds.

**Spec:** Priority 1 in `docs/superpowers/research/2026-09-10-buzz-adoption.md`.
The user's “fix priority 1” authorizes implementation in this working tree;
preserve the existing hire-delivery edits in `agent.ts`.

## Steps

- [x] Reproduce with `packages/fez-evals/tests/conversation-isolation.test.ts`:
  import the real runtime with only relay, harness, persona/key discovery and
  home-directory IO controlled. Assert cross-channel and cross-thread mentions
  do not cancel another turn or enter its prompt, same-thread follow-ups reuse
  context, and deferred doc comments remain kind 40101 with their original root.
- [x] Update `packages/fez-acp/src/agent.ts`: derive chat scope from channel and
  `parseThreadRef(event.tags).rootId ?? event.id`; derive document scope from
  channel/root for channel docs or page/root for workspace wiki pages; use that
  same scope for recent history, queue, session, and handoff. Keep metrics
  channel-based for desktop navigation. Store typed events in steering and preserve accumulated
  follow-ups through another cancellation/retry. Reserve active work before
  awaiting; remove the unreserved dispatch timer. Keep DM grouping unchanged.
- [x] Expand regressions for queued batches, late follow-ups during publish,
  retry isolation, session eviction/recycling, and document metadata. Run the
  focused test, root and ACP typechecks, ACP build, and `npm run evals`.
- [x] Review the complete diff, update research status, and report verification.

## Verification — September 10, 2026

- 20 runtime regressions pass. Cases were reproduced failing before their fixes,
  including queued-history eviction, wiki channel changes, lost steering during
  session opening, cancellation during replay, and a harness ignoring abort.
- `npx tsc --noEmit`, ACP `npm run check`, focused test-file typecheck, and ACP
  `npm run build` pass.
- `npm run evals`: **153 files passed, 1 skipped; 1,462 tests passed, 1 skipped**.
  The initial sandbox run denied local relay sockets/file watchers; the complete
  run passed with those permissions.
- Independent review findings addressed. Existing hire-delivery edits preserved.

Focused command:

```sh
npm test --prefix packages/fez-evals -- tests/conversation-isolation.test.ts
```
