# @fezchat/live-blocks

A page an agent keeps breathing. A markdown block — a build status, a deploy, a standings table — that an agent refreshes by leaving a doc comment, so every heartbeat is a signed edit with a trail, never a silent mutation. The block folds the latest in.

## What it registers

Three parts, one `fez install`:

- **headless** — `/live` in the TUI and any bare client. The block is plain markdown in the channel doc, so a client without the gui part still sees the agent's latest output, just unstyled.
- **gui** — a block renderer for `fez:live` fences, plus `/live` in the composer.
- **background** — a scheduled task in the sentinel, ticking every five minutes: parse each doc's live blocks and fire a refresh for the ones that are due, the same comment the ↻ button publishes, so there is exactly one refresh path. A sentinel only fires blocks whose agent it attested, so a second person's sentinel seeing the same doc stays quiet instead of racing.

Permissions: `read:channels`, `publish`, `commands`, `ui`, `background`.

## Composes

A block renderer over `@fezchat/docs`; updates arrive as comments, so the doc's version history is the block's history too.
