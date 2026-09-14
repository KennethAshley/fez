# Parallel browsers and packaged desktop

The user approved all three follow-ups: cancel waiting turns, package the browser
in normal Fez with secure storage/signing, and parallel browsers. They selected
side-by-side panes beside the chat. This extends the shared-queue design.

## Behavior

- A browser workspace starts with one pane. New browser adds another visible pane,
  up to four. Each pane has its own navigation, owner strip, queue and themed cursor.
  Closing or taking control of one leaves the others alone. Hiding/minimizing the
  app revokes all affected input. Narrow layouts stack panes; no invisible agent input.
- Each waiting turn has Cancel in the native owner strip. Cancellation removes
  that exact message/persona reservation and prevents polling from re-enqueuing it.
  The active driver is untouched. A later Fez message can queue that persona again.
- Computer use can list available browsers and select a target by ID or unique
  label. A successful observation binds coordinates to that target. Closing it
  never silently redirects input to another browser. Version-1 single-target
  descriptors remain supported; version 2 contains up to four complete descriptors.
- Each persona chooses one browser per Fez turn. Its first observation removes
  its placeholder reservations from the other browsers, so explicitly assigning
  Quill to Browser 1 and Drift to Browser 2 runs concurrently. Within one browser,
  the original message's addressed order remains authoritative.

## Native boundary

Replace the singleton surface/cursor/monitor with maps keyed by opaque surface ID.
The owner command resolves its surface from its exact native owner-view label.
Persona catalogs are private atomic files containing independently scoped tokens;
the public tool result lists only IDs and labels. Concurrent sockets use bounded
workers; input is serialized per surface and rechecks epoch immediately at dispatch.
Catalog and lifecycle changes must not resurrect closed surfaces or old turns.

## Packaging

Use reproducible pinned Tauri/CEF and compatible plugin sources through the normal
desktop build. Preserve com.fez.desktop, updater configuration and bundled agents.
Full app uses explicit system secret storage and a fresh persistent cache separate
from prior mock-storage experiments. Identity-free tests keep mock storage.
Signing must cover nested CEF helpers/framework and final app; verify actual
codesign output. Notarization requires available credentials and verified ticket;
missing credentials cannot be reported as successful notarization. Build local
artifacts and document their validation before any distribution decision.

## Checks

Queue cancellation rejects repeat admission but permits a later message. Owner UI
cancels the exact waiter, never a driver. MCP tests exercise target listing/routing,
stale frame refusal and legacy descriptors. Real native tests run two simultaneous
drivers, check distinct cursor labels, cancel one waiter, take/close one browser,
and verify the surviving browser still accepts only its authorized driver. Run
root typecheck and full evals, then inspect the built app and signing separately.
