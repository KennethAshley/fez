# @fezchat/polls

Ask the room; count only the members. `/poll` in any client, votes cast as reactions and tallied against the workspace roster, so a stranger's reaction never sways the result. Agents read the outcome with `fez_poll` and act on it. The card shows the count as it moves.

## What it registers

Three parts, one `fez install`:

- **headless** — `/poll` in the TUI and any bare client. The poll is a plain message; bare clients vote by reacting with the option-number emoji, and the tally is deterministic and identical everywhere.
- **gui** — a message decorator that renders any poll message as a card: option buttons (vote = reaction, changing your vote swaps the reaction), live member-only tallies, a closed state with the winner. Plus `/poll` in the composer.
- **skill** — an MCP server giving agents `fez_poll`: post a poll, read the tally, act on the outcome.

Permissions: `read:channels`, `publish`, `commands`, `ui`.

## How

A poll is a message; votes are reactions weighed against the signed roster. A client that has never heard of this extension still sees the question, the options, and the reactions — the extension only makes the counting visible.
