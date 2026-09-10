# Collaborative document workspace

Approved direction: the interactive concept reviewed on September 10, 2026. Build in the isolated `codex/docs-workspace` worktree.

The document stays central, with a persistent conversation beside it. Questions produce conversation replies. Explicit editing requests let a named agent update the actual Markdown, with authorship, a visible change, and undo. Other participants may discuss and suggest wording without silently rewriting the page. Selecting a passage gives a conversation that context. Discussions remain discoverable when text changes.

## Behavior

- Named wiki pages and channel documents share the workspace. Preserve Markdown editing, links, task checkboxes, extension blocks and page views.
- Conversation is durable kind 40101 data, grouped by actual root comment ID. Display Markdown replies and each author. Allow page conversations and passage threads, agent selection, additional mentions, resolve/reopen, loading errors and retry. Failed sends retain drafts. Switching pages cannot leak replies or drafts into another page.
- A selected quote carries surrounding text, permitting relocation after unrelated edits and disambiguation of repeated quotes. If it cannot be located safely, keep the thread visible and label the passage changed.
- Agent requests contain the user's message, not hidden output-format instructions. Runtime framing tells agents to read the document and discussion, answer questions without changing the document, and edit only on an explicit request. When several agents are addressed, a designated writer owns document changes; others review.
- Updates use the version read as their base. Refuse stale replacements with a useful retry instruction. Existing signed versions remain available. The GUI shows before/after changes and can undo the latest update by publishing another version. Undo checks the current version before writing; it never blindly overwrites newer work.
- Use existing event kinds and dependencies. Document added tags in the registry. Keep shared document semantics in the client package. No new backend or editor framework.

## Verification

Behavior tests belong in `packages/fez-evals`: signed comment scope and persistence, live updates, exact thread correlation, anchor relocation, edit conflicts and undo. Agent-runtime tests verify document framing and reply routing. Desktop browser checks exercise page creation, conversation replies, passage selection, version changes/undo, failures, and navigation. Run root typecheck, desktop typecheck/build, and the complete eval gate before completion.
