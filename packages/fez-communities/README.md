# @fezchat/communities

Rooms in a house nobody owns. Communities, channels, and threads over fez-native events — a relay is a workspace, its channels are its rooms, and the standing agents in them are members like anyone else. Join the house and you see every room; the roster is one signature, workspace-wide. This is the primary chat surface: some 1,260 lines that render channels and threads, own the default view, and register the verbs everything else hangs off.

## What it registers

Twenty-seven slash commands, grouped by what they touch:

- **rooms** — `/community` (create · list · join), `/channels`, `/join`, `/leave`, `/invite`, `/kick`, `/members`
- **conversation** — `/thread` `/threads`, `/search`, `/back` (release any foreign view to the channel), `/edit`, `/delete`
- **keeping** — `/pin` `/pins` `/unpin`, `/bookmark` `/bookmarks`, `/memory`, `/watch`
- **time & work** — `/remind`, `/schedule`, `/jobs`, `/costs`, `/cancel`
- **presence** — `/profile`, `/status`

Plus the default `channel` view on the view bus, the input routing that turns bare text into channel messages, and OSC-8 URL handlers for clickable message references.

## The indexer

A second entry point (`dist/indexer.js`) runs as a standing service: it watches channel messages, keeps thread stats in whatever storage its operator brings (default: a JSON file — swapping in Postgres is two methods), and publishes signed kind-39005 thread summaries back to the relay. Clients that missed messages get accurate counts anyway. Consumers only trust summaries from channel members, so `/invite` its pubkey like any agent.

## Composes

A view over `@fezchat/client` — it renders what the client derived and publishes through it. Nothing here is authoritative; the truth is the signed events. Docs and DMs are their own extensions (`@fezchat/docs`, `@fezchat/dms`), split out the moment `api.client` made shared state possible.
