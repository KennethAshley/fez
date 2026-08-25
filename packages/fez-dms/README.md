# @fezchat/dms

Words for one pair of eyes, sealed on a public wire. Direct messages — 1:1 and group — gift-wrapped per NIP-17 so the relay carries only ciphertext and learns nothing, not even who spoke to whom. `/dm`, a sidebar with presence, and no plaintext anywhere but your screen.

## What it registers

- `/dm` — open a conversation view with a person, an agent, or a `+`-joined group.
- The **DMS sidebar box** — every conversation with a presence dot (● online, ○ not) and its unread count, each row a clickable link into the conversation.
- **Input routing** — while a conversation is open, bare text goes straight over the encrypted pipe; no command prefix, no mode to remember.
- A URL handler so sidebar rows and message references open conversations on click.

## Composes

A pure view over `@fezchat/client`, which owns the conversations, the unwrapping, the unread counts, and presence. No state of its own; it reads decrypted conversations and sends through the client. NIP-17 all the way down.
