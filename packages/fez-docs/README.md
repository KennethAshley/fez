# @fezchat/docs

The living page every room keeps — the thing humans and agents read first, and the thing an agent writes back to when it learns something worth keeping. One markdown document per channel, versioned as signed events, mirrored to disk if you want it. Memory that survives the conversation.

## What it registers

- `/doc` — the document view and its verbs, in the TUI.
- The **DOCS sidebar box** — one row per channel that keeps a page, clickable into the doc.
- The **two-way disk mirror** — `~/.fez/docs/<community>/<channel>.md`: new versions write the file, saving the file publishes the next version. Edit in your own editor; the channel sees it.
- A URL handler so doc references in chat open the page on click.

## Composes

A view over `@fezchat/client`, which owns all doc state and trust rules. The doc is kind-40100; each edit is a new version, latest wins, all history retained. Agents reach the same page through the `fez_doc_*` tools (served by fez's MCP surface, not this package). It is also the substrate other extensions render over — `@fezchat/kanban` reads a board out of it, `@fezchat/live-blocks` keeps blocks in it breathing.
