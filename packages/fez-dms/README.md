# @fez/dms

Private direct messages — 1:1 and group — as a pure view over `@fez/client`. `/dm`, a DMS sidebar with presence. Every message is NIP-17 gift-wrapped: ciphertext on a public relay, no metadata leak.

## Composes

No new state of its own — it reads the client's decrypted DM conversations and sends through it. The relay never sees plaintext.
