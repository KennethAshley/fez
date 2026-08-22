# @fez/relay

The database — and it is deliberately dumb. A NIP-01 + NIP-50 store with hardening (dedup, size caps, replaceable-event compaction, reconnect-friendly) and OPTIONAL operator policies: membership enforcement at ingest, NIP-42-gated reads, moderation. A bare relay stays a dumb store; clients never depend on a smart one.

## Extensions

`--extensions` loads relay parts (git over HTTP, media) that register HTTP handlers, ingest policies, and NIP-11 advertisements. The relay holds no signing key — an extension can record and serve, never speak.

## Run

```bash
node packages/fez-relay/dist/cli.js --port 7777 --store events.jsonl --owner <pubkey> \
  --extensions --origin https://your-relay
```
