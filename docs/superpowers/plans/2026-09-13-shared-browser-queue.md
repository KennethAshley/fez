# Shared Browser Queue Implementation Plan

> Execute inline in the current browser integration branch; preserve existing work.

**Goal:** Attached local agents share one browser in instruction order, with visible waiting and owner takeover.

**Architecture:** The TypeScript agent runtime publishes a small, private, expiring context (effective tool names and current message's ordered addressees). The native host uses that context for its exclusive input ownership queue. The Computer use extension waits for its slot before obtaining a fresh screenshot. Native input remains the final epoch-checked boundary.

**Tech stack:** Existing TypeScript/Node, MCP, Rust/Tauri/CEF; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-13-shared-browser-computer-use-design.md`, extended by the user's shared-queue approval.

## Constraints

- One browser; parallel browsers are deferred.
- No agent picker: effective Computer use attachment makes a running local agent eligible.
- Reserve all explicit addressees together, in prose order, even if a later agent requests first.
- Take control pauses acquisition globally. Only the owner can resume.
- Finishing, failing, cancelling, losing runtime heartbeat, or closing the browser releases input authority. Every new driver must observe again.

## 1. Runtime context and addressing

- [x] Add `packages/fez-acp/src/tool-context.ts`: private atomic JSON publication, heartbeat, `run({id,order}, callback)` with completion in `finally`, close cleanup. Keep effective tool names, persona, process identity and timestamps; never message text or credentials.
- [x] Wrap `promptSession` through this context for channel and DM turns; expose no browser-specific API from core.
- [x] Extend `addressing.ts` to recognize unconditional `then @name`, preserving conditional downstream handoffs and quoted mentions.
- [x] Test actual file lifecycle, failed/cancelled turns and ordered addressing in `packages/fez-evals`.

## 2. Native ownership queue

- [x] Add focused `native_surface_queue.rs`: validated runtime contexts, ordered reservations, readiness, release on completion/expiry, persistent pause and resume. Test the state transitions through the existing opt-in native regression.
- [x] Update `native_surfaces.rs` to issue persona descriptors for attached live runtimes, acquire on observation, enforce driver identity and epoch on every input, poll for finished turns, hide the prior cursor on handoff.
- [x] Keep the identity-free lab's explicit grant path for existing regressions; exercise named queue participants using disposable runtime contexts.

## 3. Waiting and owner strip

- [x] Computer use polls bounded queue responses before its first screenshot, reports MCP progress while waiting, respects cancellation, and never retries refused input.
- [x] Replace owner picker with `@quill driving · @drift waiting`, Take control / Resume agents, Stop. Keep lab grant support.
- [x] Test waiting, fresh screenshot, cancellation, and owner controls using real MCP transport and DOM fixtures.

## 4. Integration gate

- [x] Run focused evals, root and package typechecks, desktop build, full eval gate.
- [x] Build the pinned native lab and run native queue / takeover tests.
- [x] Rebuild bundled agent and native desktop. Demonstrate two agents using one message and verify real browser state, order, cursor label and takeover.
- [x] Record results here; leave the local browser ready for the user.

## Verification notes

- First native queue regression passed: both MCP clients drove the real CEF page, shared a single input lease, used distinct cursor labels, and paused/resumed without stale frames.
- Added delayed-start coverage: Drift requests before Quill's runtime exists; the local persona reserves Quill's position without granting input to a missing process. Native regression passed alone after a concurrent native build caused a window visibility failure.
- MCP cancellation stops queue polling; transport tests pass (15 cases). Queue state-machine Rust checks pass (2 cases). Core/ACP/Computer use typechecks and desktop frontend build pass.
- First live message at 15:55: Quill clicked Learn more; owner strip showed `@quill driving · @drift waiting`; Drift subsequently opened IANA Domain Name Services. This exposed Quill re-summoning Drift in its reply. The runtime now leaves already-addressed peer references as plain names and tells each agent to complete only its existing step. Genuine new handoffs remain mentionable.
- Native app bundle includes `0.84.2+svc29`. Quill and Drift have Computer use attached locally.
- The experimental native window painted blank at its initial size on this launch. Maximizing repainted it; restoring brought the blank rendering back. No queue code was changed to mask that upstream/native rendering issue. The live test ran in the maximized window.

### Repaint investigation, 2026-09-13 16:36 EDT

- The existing build rendered correctly at normal size on two clean restarts, without maximizing. Opening the native browser, dragging the window smaller, and maximizing/restoring also rendered correctly. The blank-window symptom did not reproduce; its cause remains unconfirmed. The earlier description as an upstream issue was a hypothesis, not a diagnosis.
- The existing native MCP/CEF regression passed again (8.76 seconds), including resizing, minimize/restore, visibility and shared-queue checks. Log: `/private/tmp/fez-repaint-native-check.log`. This checks native browser behavior, not root-window compositor pixels.
- Sky captures of both fresh launches showed the real channel UI: `/private/tmp/fez-repaint-before.jpg` and `/private/tmp/fez-repaint-relaunch.jpg`. The first accessibility snapshot omitted web content despite the window painting normally; accessibility readiness alone must not be used to classify a blank window.
- No rendering code was changed and no repaint fix is claimed. Next failure needs a user-visible blank window plus its launch/resize circumstances before choosing a correction.

- Final full eval gate: **2,470 passed, 11 skipped** (290 files passed). Final root and ACP typechecks passed. Native queue regression passed separately.
- Final live test at **16:01**: one owner message produced exactly two replies. Quill opened **Example Domains**, then Drift opened **Domain Name Services**. Both contexts finished on the same original request ID, with no follow-up summons. The successful thread is left open in the maximized native app. Evidence: `/private/tmp/fez-shared-queue-final-result.jpg`; original driving/waiting evidence: `/private/tmp/fez-shared-queue-live.jpg`.
