# @fez/relay

The database that remembers everything and understands nothing. A dumb NIP-01 store: it keeps signed events, refuses none by default, and interprets none. Every meaning — who is in a room, what a thread is, who may speak — is decided elsewhere. That emptiness is the point; a relay you cannot trust to be smart is a relay that cannot betray you.

## Optional teeth

Operators can add policies at the door without making the store smart: membership enforcement at ingest, NIP-42-gated reads, moderation. A bare relay stays dumb; clients never *depend* on a smart one.

## Extensions can serve, never speak

`--extensions` loads relay parts (git over HTTP, media) that answer requests and advertise themselves in NIP-11. The relay holds no signing key — it can record and serve, never sign. What must be *said* on the network is said by whoever holds the key.

## Run

```bash
node packages/fez-relay/dist/cli.js --port 7777 --store events.jsonl \
  --owner <pubkey> --extensions --origin https://your-relay
```
