# @fezchat/loom

**Describe a tool. Get a live one.** Loom is the "Uniswap for agents" idea, made
fez-shaped: one text box, you bring the data and the prompt, an agent weaves the
UI. The tool is a **thin client over verifiable relay data** — not a black box —
and the good ones crystallize into installable extensions.

## How it works

`@loom` is a builder agent. Ask it for a tool over your workspace data:

> @loom give me a live board of open approvals

It ships a **live artifact** — sandboxed, self-contained HTML with one channel
back to fez: a **read-only** bridge.

- `window.fez.query(q)` → Promise of rows
- `window.fez.subscribe(q, cb)` → live rows, re-fires on change, returns unsubscribe

`q` is the fez query language in plain words: `open approvals`, `open tasks`,
`pages this week`, `mentions`, `runs`. Rows: `{ id, title, group, who?, done?, ts, meta? }`.

## The trust model (why this is safe)

The tool runs in an origin-null iframe: no cookies, no parent DOM, **no keys, no
network egress** (CSP `connect-src 'none'`). The only data it can touch is what a
**bounded, validated query** returns. It can render anything and read what you
let it; it can do nothing else.

Write-back — a tool that publishes *as you* — is the wallet shape: the tool can
only **propose** a bounded, allowlisted action, and the host describes it to you
and publishes only on your explicit per-write consent. It never holds a key.

- `window.fez.react(messageId, emoji)` — add a reaction, as you
- `window.fez.message(text)` — post into the tool's own thread, as you

Writes are bound to the channel (and thread) the tool was published into —
never to whichever channel you happen to be looking at. Reads are free;
every write asks.

## Status

Experimental. The `@loom` builder persona, the read bridge (`artifact:live` in
fez core), the tool pane, and consented write-back all ship. Next: a "keep this"
gesture that crystallizes a tool into its own extension.
