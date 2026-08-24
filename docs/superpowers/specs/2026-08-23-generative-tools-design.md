# Generative streaming tools for fez — experimental feature design

**Status:** draft for review · **Date:** 2026-08-23 · **Type:** experimental

Working name: **`@fezchat/loom`** (a loom weaves live views). Alternatives on the
table: `lens`, `studio`, `canvas`. **← decide the name before we build.**

## The idea (Uniswap-for-agents)

One text box. You bring the data and the prompt; a **builder agent** builds the
UI. The interesting version isn't "agents get a UI" — it's: *the relay is a
trustless event substrate, the box generates thin clients over it, and the good
ones crystallize into installable extensions.*

Uniswap's real move wasn't "simple UI" — it was collapsing a domain into one
atomic, verifiable unit (the swap). The simplicity is downstream of the trust.
So our discipline: a generated tool is a **view over verifiable relay data**,
not a black box that recomputes and asks you to trust its math.

## What already exists (we are ~70% there)

- **`parseQuery` / `Query`** (`fez-client/query-lang.ts`) — a natural-language
  query language. Sources: `tasks|approvals|pages|comments|runs|spend|mentions`.
  Views: `list|table|board`. Bounded (time/limit), safe, declarative.
- **`QueryBlock.tsx`** — a ` ```fez:query ``` ` block answered live from the
  relay, with the subscribe/cleanup loop already written. **This is a streaming
  view today.**
- **`live-blocks`** extension — an agent keeping a block *breathing*.
- **Artifacts** (`artifact-viewers.tsx`) — HTML rendered in a **sandboxed
  iframe** (`sandbox="allow-scripts"`, `srcDoc`), via an extensible viewer
  registry. This is the "build anything" primitive, already origin-isolated from
  keys and parent DOM.
- **`registerPageView`** (extension-api) — extensions can own a pane/page surface.

## Architecture

Two generation tiers on a spectrum, chosen by the ask:

| | Spec view (`parseQuery`+`QueryBlock`) | Sandboxed artifact |
|---|---|---|
| Vocabulary | bounded (list/table/board/…) | **anything** |
| Live/streaming | free (subscribe loop) | via the new read bridge |
| Safe re: keys | yes (bounded query, no eval) | yes (origin-null iframe) |
| Crystallize | trivial (spec is tiny) | possible, heavier |

**Where it renders — decided:** the tool renders in a **right-side pane** (same
slot as `docs`/`memory`/`watch`). The **thread holds only a handle** — a compact
card ("▣ branch board · built here · open →"). Inline-*rendered* live tools are a
trap (too narrow, scroll-fights, scroll away). "Maintains in the thread" = the
thread keeps the *reference* + the authoring conversation; the pixels live in the
pane.

```
┌─ #general ───────────┬─ [ live tool: branch board ] ─┐
│ you: make a branch…  │   todo-app   ● ken            │
│ ┌─ ▣ branch board ─┐ │   cool-repo  ● mo             │
│ │ built · open →   │ │    · streaming ·              │
│ └──────────────────┘ │                               │
│ you: group by repo   │                               │
│ ____ prompt ________ │                               │
└──────────────────────┴───────────────────────────────┘
     thread = log + handle       pane = the tool
```

**Lifecycle (spatial = state):**
- inline card → born, tied to the thread
- open → pane → the workbench where it lives and streams
- crystallize → the pane view saves as a `registerPageView` extension = a
  permanent rail destination

### The one core seam: the read bridge

The load-bearing new primitive. A sandboxed artifact currently has **no channel
back** to fez. Add a **read-only** `postMessage` bridge exposed to the iframe:

- artifact calls `fez.query(<query>)` / `fez.subscribe(<query>, cb)`
- host validates the query through `parseQuery` (already bounded/safe), runs it,
  streams results back into the iframe
- **read-only, scoped** — the artifact never sees the key; it can only read what a
  bounded query returns. This is the safe half of the same capability channel
  that later (consented, scoped) enables write-back.

This is the crux experiment: it turns "build anything" (static artifact) into
"stream anything" (live artifact) without weakening key custody.

### The builder agent

A persona (claude-code harness) that turns "make me X over @channel" into either
a spec (preferred when it fits the vocab) or a sandboxed artifact (for
"anything"). Streams the result into a thread handle + pane. Ships in the package.

## MVP scope (v0 — the thing to play with)

**In:**
1. Core: the **read bridge** (`postMessage` `fez.query`/`subscribe`, read-only,
   query-validated).
2. Extension `@fezchat/loom`: builder-agent persona + a **tool pane** (renders the
   artifact/spec) + the **thread handle card**.
3. Read-only, streaming, in-thread → open-in-pane.
4. **swap** semantics: one pane, newest tool wins.

**Deferred (explicitly):**
- **Write-back** (consented scoped capabilities) — v2, the loaded-gun problem.
- **Crystallize-to-extension** — v1.5 (save the pane view as a package).
- **Spec-view vocabulary** growth (timeline/tally/chart renderers) — as needed.
- **Shelf** (flip between multiple tools in a thread) — add only if swap feels
  lossy.

## Open decisions (defaults chosen — veto any)

1. **Name** — default `@fezchat/loom`. *(most want your call)*
2. **Start tier** — default: artifact + read bridge first (the novel "build
   anything"), spec-view reuse as a fast-path later. Alt: spec-view first (cheaper,
   less flashy).
3. **Pane multiplicity** — default swap (newest wins), shelf deferred.

## Risks / holes to poke

- Read bridge is the trust boundary — validation must go through `parseQuery`, no
  raw filter passthrough, no network capability granted to the iframe (tighten CSP
  so a "build anything" artifact can't phone home with what it read).
- Streaming a *whole artifact* re-render is expensive vs a spec patch; the bridge's
  `subscribe` should push data deltas, not re-emit the artifact.
- "User brings the data" is load-bearing: if the data isn't on the relay, the box
  can't invent it (guard against fabrication — an empty query is "nothing here,"
  never a made-up dashboard).
