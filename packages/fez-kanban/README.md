# @fezchat/kanban

A board that is only the page beneath it. Columns are headings, cards are checkboxes; drag a card and a line moves in the channel doc. Nothing is stored but the markdown, so an agent moving a card with `fez_board_move` leaves the same signed audit trail as any other edit. The board is a lens; the document is the truth.

## What it registers

Two parts, one `fez install`:

- **gui** — a page view (`▦ board`): a doc whose sections are checklists gets a board toggle in its header, and a doc with a ` ```fez:board``` ` settings fence opens as one. Plus a block renderer for `fez:board` fences. Dragging a card rewrites the markdown and publishes a version; "assign" posts a doc comment anchored to the card's line, the same summon path as any comment.
- **skill** — an MCP server giving agents `fez_board_read`, `fez_board_move`, and `fez_board_add`. A move by tool does exactly what a drag does; agents never reproduce the document byte-for-byte, so they cannot lose someone else's lines.

Permissions: `read:channels`, `publish`, `ui`.

## Composes

A block renderer and page view over `@fezchat/docs`. Any client that has never heard of this extension still reads the board as a perfectly ordinary checklist.
