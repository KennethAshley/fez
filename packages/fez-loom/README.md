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

Write-back — a tool that publishes *as you* — is deliberately not here. That needs
a separate, consented, scoped capability (the wallet-approves-a-bounded-transaction
shape). This is the read-only half.

## Status

Experimental. v0 ships the `@loom` builder persona; the read bridge (`artifact:live`)
lives in fez core. Next: a dedicated tool pane + thread handle, and a "keep this"
gesture that crystallizes a tool into its own extension.
