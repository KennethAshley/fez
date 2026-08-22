# @fez/kanban

A board that is only the page beneath it. Columns are headings, cards are checkboxes; drag a card and a line moves in the channel doc. Nothing is stored but the markdown, so an agent moving a card with `fez_board_move` leaves the same signed audit trail as any other edit. The board is a lens; the document is the truth.

## Composes

A block renderer and page view over `@fez/docs`.
