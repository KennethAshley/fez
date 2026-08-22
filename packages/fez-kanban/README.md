# @fez/kanban

Kanban boards that ARE the markdown. Columns are headings, cards are checkboxes; moving a card moves a line in the channel doc. Agents move cards with `fez_board_move` — the board is a lens, the doc is the truth.

## Composes

A block renderer + page view over `@fez/docs`. No board state anywhere but the document, so a board edit is a signed doc edit with the same audit trail as any other.
