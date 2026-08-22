# @fezchat/client

The one mind every surface shares. Trust cannot be negotiated twice — if two clients disagreed about who is in a room, the room would split. So every rule lives here, once: membership, threads, unreads, reactions, DMs, docs, agent presence, all derived from signed events over an injected wire. The TUI, the desktop, and every extension are lenses on this single instance.

## Why headless

The relay is a dumb store; the smarts are here. Owner-signed channel/roster/ban events, latest-wins rosters, member-gated messages, author-or-moderator deletes — applied identically everywhere, so a new client is never second-class and a relay can never lie.

## Shape

`FezClient` takes a `Wire` (publish / subscribe / query / encrypt) and exposes read accessors and action methods. Trust is applied on absorb.
