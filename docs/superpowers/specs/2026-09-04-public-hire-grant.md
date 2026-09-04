# The Public Hire Grant — one stranger, one repo, one deadline

*2026-09-04. The missing 20% of "hire a remote coding agent over relay
git" (conversation of 9/3 night). Everything else exists: fez-git already
serves smart-HTTP from the relay with NIP-98 nostr auth, agents push as
their own npub, personas with `repo:` clone at spawn, escrow settles the
money. The one gap: authorization is roster-flat — members read/write
everything, strangers nothing. A hire needs a scoped, expiring middle.*

## Thesis

A grant is **per-repo, per-pubkey, expiring write access** — the
credential half of a hire. It rides the rails that already exist:

- **Carrier:** the repo channel's meta (47101, owner-signed, latest-wins
  — the same place `protect` and `upstream` already live). New meta key:
  `grants: "<pubkeyHex>:<expiresUnixS> <pubkeyHex>:<expiresUnixS>"`.
  No new event kinds, no second permission model — the comment in
  serve.ts warning against one stays satisfied: this is the SAME model
  (owner-signed channel meta), extended one key.
- **Enforcement:** `rosterAccess.canRead/canWrite` — whose signatures
  already take the repo and ignore it. Grant check: pubkey has an
  unexpired entry in that repo's grants and is not banned. Grantees are
  NOT roster members, so `isPrivileged` stays false — a hired stranger
  can push its branch but never a protected ref (`main`). That guardrail
  costs zero new code; it falls out of the existing hook.
- **Revocation:** republish the channel meta without the entry (or let
  it expire). Latest-wins resolution is already implemented on both the
  relay and client ends.

## Verbs (headless `/repo`, owner-only like `protect`)

- `/repo grant <repo> <pubkeyHex> <hours>` — add/replace the entry,
  reply with the clone URL to hand the worker and the expiry.
- `/repo revoke <repo> <pubkeyHex>` — remove it now.

Owner authority = the existing one: `channels.ensure` refuses non-owners.

## The hire flow this completes

1. Escrow open (9/3's verbs) + `/repo grant` + directed task in the
   guest DM carrying the clone URL, branch name, spec, deadline.
2. Worker's owner points a coding persona at the URL (`repo:` — clones
   at spawn); it works on ITS machine, pushes its branch as ITS npub —
   the same key that carries its bazaar record. Résumé and commit log,
   one identity.
3. Poster pulls, runs tests, releases escrow (or refunds on lapse).
   Grant expires on its own; nothing to clean up.

A repo is a folder of anything — the same grant carries writing, data,
docs hires. Code is the case where verification is mechanical.

## Non-goals

Read-only grants (write implies read here; a hire that only reads is a
lease question), per-branch grants (protect already fences refs),
auto-grant on escrow open (ceremony glue, later), private repos to
strangers-with-encryption (the 9/3 bundle flow covers that when privacy
returns).

## Gates

- Pure: parse/format round-trips; expired entries inert; banned beats
  granted; non-owner cannot mint (existing ensure refusal).
- Live: a stranger key clones and pushes a branch on a granted repo,
  is refused on `main` (protected), and is refused everything after
  expiry/revoke — with the roster untouched throughout.
