# @fez/moderation

Moderation as signed trust, not admin buttons. `/report` (encrypted to the community creator), a `/reports` queue, `/ban` and `/unban` via creator-signed 30047 ban lists. Enforcement is the shared client trust rules plus the relay's optional moderation policy.

## How it holds

A ban is a creator-signed event every client honors; there is no privileged account to compromise. The relay can enforce at ingest, but a compliant client enforces anyway.
