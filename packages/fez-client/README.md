# @fez/client

The headless brain. All of fez's derived state and every trust rule live here — membership, threads, unreads, reactions, DMs, docs, agent presence — computed from signed nostr events over an injected wire. No UI. The TUI, the desktop app, and every extension consume one instance.

## Why headless

State and trust must be identical everywhere or two clients disagree about who is in a room. So the rules live in exactly one place and the surfaces are lenses over it. A relay stays a dumb store; this package is the smarts.

## Shape

`FezClient` takes a `Wire` (publish / subscribe / query / encrypt) and exposes read accessors and action methods. Trust is applied on absorb: owner-signed channel/roster/ban events, latest-wins rosters, member-gated messages, author-or-moderator deletes.
