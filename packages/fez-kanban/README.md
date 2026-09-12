# @fezchat/kanban

A board that is only the page beneath it. Columns are headings, cards are checkboxes; drag a card and a line moves in the channel doc. Nothing is stored but the markdown, so an agent moving a card with `fez_board_move` leaves the same signed audit trail as any other edit. The board is a lens; the document is the truth.

## What it registers

Three parts, one `fez install`:

- **gui** — a page view (`▦ board`): a doc whose sections are checklists gets a board toggle in its header, and a doc with a ` ```fez:board``` ` settings fence opens as one. Plus a block renderer for `fez:board` fences. Dragging a card rewrites the markdown and publishes a version; "assign" posts a doc comment anchored to the card's line, the same summon path as any comment.
- **skill** — an MCP server giving agents `fez_board_read`, `fez_board_move`, and `fez_board_add`. A move by tool does exactly what a drag does; agents never reproduce the document byte-for-byte, so they cannot lose someone else's lines.
- **headless / background** — daily board reviews through the existing sentinel. A named board's **Schedule review** control selects the agent, local time, time zone and instructions. **Pause**, **Resume**, **Edit schedule** and **Remove schedule** live on that board.

Permissions: `read:channels`, `read:agents`, `publish`, `sign`, `background`, `ui`. Scheduling is off until the owner saves a review. Attach the `kanban` tool to the review agent's `mcpServers` so it can read and move cards.

## Daily reviews

Create a named doc page with Backlog, In Progress, Review and Done columns, open its board view, and choose **Schedule review**. Each due review opens one addressed assignment thread in the board's channel. The agent reads the board, chooses at most one actionable task, reports actual checks, and leaves the result in Review for the owner to accept.

Schedules are self-encrypted extension settings. The background runner rechecks those settings and the agent's membership/owner attestation before delivery. Retries and concurrent hosts using the same settings keep the same event ID, and an unfinished assignment prevents another daily run. Agents must finish with `fez_complete_work`; an ordinary chat reply is not a completion receipt.

Daily jobs use a stable timestamp derived from the review date (00:00 UTC minus 14 hours), so their event time can precede delivery. The agent and sentinel accept these late deliveries, and agent history recovery overlaps 72 hours. A failed board is reported without blocking other boards.

The minute-based poll follows the selected IANA time zone through daylight-saving changes. Saving or resuming starts at the next scheduled time. When Fez was offline, only today's due review catches up; missed days are not replayed. Pause stops future assignments and leaves current work running. Keep Fez running with Always On enabled for unattended reviews. Delivery failures appear in the background runner's logs under `kanban-daily-review`.

## Composes

A block renderer and page view over `@fezchat/docs`. Any client that has never heard of this extension still reads the board as a perfectly ordinary checklist.
