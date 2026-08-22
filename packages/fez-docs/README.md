# @fez/docs

The channel doc — one living markdown document per channel, the thing humans and agents read first. `/doc`, a DOCS sidebar, an optional disk mirror. Agents edit it with `fez_doc_*`; every version is a signed event.

## Composes

A view over `@fez/client`. The doc is kind-40100; edits are new versions, latest wins, full history retained.
