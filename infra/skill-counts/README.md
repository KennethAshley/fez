# skill-counts — the global install counter (company infrastructure)

The cross-relay index over signed kind-40201 install receipts: npmjs.com
to fez's npm. This is **fez-company infrastructure** — a tier above any
relay operator's storage (which holds the wire itself: events, stats,
bans). Relays stay the source of truth; this service is a rebuildable
cache that makes one universal number.

- **Writes**: POST a full signed 40201 receipt. The schnorr signature is
  verified before counting — the index is exactly as honest as the wire.
  Counts are DISTINCT installer pubkeys per (skill, listing author).
- **Reads**: GET returns aggregates (optionally ?name= & ?author=).
- **Trust**: sybil-able by minting keypairs (like every install counter
  ever), never spoofable on someone else's behalf.

Deploy `schema.sql` + `function/index.ts` to the company's Supabase
project (edge function name: `skill-installs`, JWT verification off —
signature verification IS the auth). Then set the function URL as
`DEFAULT_SKILL_COUNTS_URL` in `src/settings.ts`. Clients fall back to
relay-local receipt counts whenever the index is unreachable or unset.
