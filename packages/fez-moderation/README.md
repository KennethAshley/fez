# @fezchat/moderation

Banishment by signature, not by button. `/report` seals a complaint to the community's creator; `/ban` is a creator-signed edict every client honors on sight. There is no admin throne to seize — enforcement is the shared trust rules, and a compliant client obeys the edict whether or not the relay bothers to.

## How it holds

A ban is a signed 30047 event, not a database row. No privileged account exists to compromise; the relay may enforce at ingest, but the client enforces regardless.
