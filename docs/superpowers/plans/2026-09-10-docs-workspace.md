# Collaborative Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build the approved document workspace with durable agent discussion, passage feedback, safe direct Markdown edits, and undo.

**Architecture:** Keep 40100 versions and 40101 discussion events. Share anchor and version validation in the client package. The desktop owns presentation; the existing agent runtime and MCP tools perform agent work.

**Tech Stack:** TypeScript, React 19, existing Markdown renderer, Nostr signed events, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-docs-workspace-design.md`

## Global Constraints

- Work only in `/private/tmp/fez-buzz-main`, branch `codex/docs-workspace`.
- Preserve the original dirty checkout. Do not merge or push this feature.
- Use existing event kinds and dependencies. No `as any`.
- Shared document semantics belong in `packages/fez-client`.
- Keep failed drafts, reject stale document replacements, and preserve signed history.
- New behavior needs tests in `packages/fez-evals`. Run the full eval gate and typechecks.

### Task 1: Shared document and agent-tool contracts

**Files:** `packages/fez-client/src/index.ts`, new `packages/fez-client/src/docs.ts`, `packages/fez-mcp/src/server.ts`, `src/protocol/kinds.ts`, new `packages/fez-evals/tests/doc-workspace.test.ts` and focused MCP tests if needed.

**Interfaces:**

```ts
export interface DocAnchor { text: string; prefix: string; suffix: string }
export function createDocAnchor(content: string, start: number, end: number): DocAnchor;
export function locateDocAnchor(content: string, anchor: DocAnchor): { start: number; end: number } | undefined;
// Export through client index. Exact quote + context matching; never pick an ambiguous occurrence.
// DocCommentThread gains optional anchorContext?: DocAnchor and writerPk?: string.
// publishDocComment opts gain anchorContext?: DocAnchor, writerPk?: string;
// it returns Promise<WireEvent> so the UI knows the actual root ID.
// resolve:false publishes a reopen marker; unspecified publishes no marker.
// ClientEvents gains docCommentsChanged: (channelId: string) => void.
// publishDoc/publishWikiDoc return Promise<WireEvent>; their existing baseId argument
// rejects an outdated version, including undefined when a page already exists.
```

- [x] Write failing tests for two equal quotes with distinct context, shifts above a quote, ambiguous or missing quotes; round-trip anchor metadata; signed live comment notifications; reopened threads; channel docs excluding wiki comments; publish returning its signed ID; stale update refusal with no publication.
- [x] Run the focused tests and confirm behavioral failures.
- [x] Implement the helpers and client changes. Use existing membership checks, wire subscription, and version ordering. Emit local publish notifications without requiring a relay echo.
- [x] Update MCP reads to expose the version and cache the exact read version per page. Writes compare that version (or explicit `baseId`) before replacing. Add a `fez_doc_edit` tool with `channel`, optional `page`, `baseId`, exact unique `before`, and `after`; it rejects stale or ambiguous edits. Reuse shared helpers and preserve document titles. Append must not claim concurrent writes cannot collide.
- [x] Make MCP conversation reads share thread semantics and identify authors. Document `anchor-context` JSON and optional `writer` pubkey tags on 40101 in the registry.
- [x] Run focused tests and package typechecks, inspect the diff, and report changed files plus exact evidence. Do not commit other workers' files.

### Task 2: Desktop document conversation and changes

**Files:** `packages/fez-desktop/src/WikiView.tsx`, new `packages/fez-desktop/src/DocConversation.tsx`, new `packages/fez-desktop/src/doc-workspace.ts`, `packages/fez-desktop/src/App.css`, `packages/fez-desktop/src/App.tsx`, `packages/fez-desktop/tests/e2e/docs.spec.ts`, focused eval tests.

**Interfaces:** Consume Task 1's comment ID return, anchor helpers, safe document publish, and live comment notification. `DocConversation` receives selected page identity, versions, threads, selected anchor/thread and callbacks. Keep the existing Markdown/extension renderer in WikiView.

- [x] Write failing tests covering changes and anchor selection plus a browser scenario for live threaded replies and undo.
- [x] Replace the transient bottom agent composer and overlapping comment popovers with a persistent conversation/changes rail. Preserve explicit local query blocks; do not guess that a natural-language question is a query.
- [x] Select actual text or use a passage discussion button, attach quote context, and display all threads including unmatched anchors. Sending a follow-up retains the root ID and selected writer, with additional mentions resolved by the existing roster rules.
- [x] Add Markdown message rendering, clear loading/error/retry states, resolve/reopen, page navigation isolation and stale load protection. Preserve drafts until sends succeed.
- [x] Pin the editor's original base, show attributed before/after changes, and implement guarded undo as a new version. Route the channel-document entry point into this same workspace.
- [x] Verify creation/editing, preserved extension views, discussion, live version receipt, undo and narrow-window layout in the browser.

### Task 3: Agent document conversation framing and final verification

**Files:** `packages/fez-acp/src/agent.ts`, `packages/fez-evals/tests/acp-conversations.test.ts` or a focused neighboring runtime test.

- [x] Add runtime tests asserting a document question stays in its thread, receives context and designated-writer guidance, and sends no channel reply.
- [x] Carry the per-turn writer pubkey through doc turn queuing. Read thread context before responding; edit only when explicitly asked and designated writer. Use version-aware document tools and reply in the same root.
- [x] Review each task and the whole feature with an independent reviewer; fix actionable findings.
- [x] Run root and changed-package typechecks, build, complete eval gate, and desktop browser tests. Record evidence and keep the completed feature in its worktree.

## Completed verification

- Root `npx tsc --noEmit`, ACP and desktop typechecks passed.
- `npm run build`: core + 45 packages passed.
- `npm run evals`: 175 files passed, 2 skipped; 1,625 tests passed, 3 skipped.
- Desktop Playwright document scenario passed against a real local relay with a test signing bridge. Includes live threaded replies, requested-edit publication, undo, saved and failed drafts, stale-edit rejection, long/cross-block selections, creation, stable page addresses, and narrow-window editing.
- Native runtime regressions exercise writer/reviewer framing, full selection context, exact-thread history, queue/steer/retry routing, and no duplicate channel replies. Model responses use the existing deterministic harness fixture.
- Independent task and final reviews approved after regression fixes. Focused lint has no errors; the generation-counter cleanup retains one hooks warning.
- Feature remains in its worktree; no merge or push.
