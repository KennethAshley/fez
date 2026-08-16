# Operator reference: fez on Supabase

Runs a fez relay and thread indexer with **Supabase (Postgres)** as the
backing store, plus a ban-list ingest policy read from a table. This is
*one operator's* setup — every integration point here is a generic seam
(`EventStore`, `IndexStore`, `RelayPolicy`); swap Supabase for anything.

## Setup

1. `npm install @supabase/supabase-js` (in this directory or globally
   resolvable from it).
2. In the repo root `.env` (gitignored, loaded automatically):

   ```
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_KEY=<service_role key>
   ```

   The service-role key is correct here: the relay/indexer are trusted
   operator processes. Keep RLS on for every other client.

3. Create the tables (SQL editor → run `schema.sql`).

## Run

```bash
# relay: Postgres-backed durability + membership/rate-limit/ban policies
node packages/fez-relay/dist/cli.js --port 7777 \
  --config examples/operator-supabase/relay.config.mjs \
  --policy membership --policy rate-limit

# indexer: thread stats into Postgres
FEZ_INDEXER_CHANNELS=general \
FEZ_INDEXER_STORE=examples/operator-supabase/index-store.mjs \
fez run packages/fez-communities/dist/indexer.js -r ws://localhost:7777
```

Ban a pubkey by inserting its hex into `fez_banned_pubkeys` — takes
effect within the policy's 30s cache window, no restart.
