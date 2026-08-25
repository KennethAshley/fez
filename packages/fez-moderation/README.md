# @fezchat/moderation

Banishment by signature, not by button. `/report` seals a complaint to the community's creator; `/ban` is a creator-signed edict every client honors on sight. There is no admin throne to seize — enforcement is the shared trust rules, and a compliant client obeys the edict whether or not the relay bothers to.

## What it registers

- `/report <who> <reason>` — a kind-1984 report with the accusation NIP-44-encrypted to the community's creator. A public relay must never carry a plaintext accusation; observers learn only that someone reported something here.
- `/reports` — the creator-only queue: decrypts every report addressed to you.
- `/ban <who>` · `/unban <who>` — edits to the creator-signed kind-30047 ban list, latest wins, same trust chain as the roster.
- `/bans` — the list as it stands.

## How it holds

A ban is a signed 30047 event, not a database row. No privileged account exists to compromise; every client's trust rules treat banned pubkeys as non-members, and a relay running the moderation policy rejects their writes at ingest — but the client enforces regardless.
