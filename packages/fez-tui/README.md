# fez-tui — Fez's chat-TUI layer

## What this package is now

Fez's terminal chat interface (`fez` with no args → `FezTUI` in `src/tui.ts`)
renders through **`@earendil-works/pi-tui`** (MIT, pinned to an exact
version in package.json), which fully owns the terminal: raw-mode stdin,
differential main-screen rendering, a real line editor (history, cursor
movement, autocomplete hooks), markdown. Node's `readline` is **gone** from
the codebase.

This package is the layer between that engine and Fez:

- re-exports the engine surface production uses (`index.ts`) so the rest
  of Fez imports everything TUI-shaped from one place
- Fez-owned components built on the engine's `Component` interface:
  - `Footer` (`footer.ts`) — the persistent status bar extensions publish
    into via `ui.setStatus(key, value)`; a pi-tui `Text` pinned at the
    bottom of the layout. Its `setStatus` contract is stable regardless of
    what renders it.
  - `theme.ts` — the chalk-based themes (markdown, editor, loader) in one
    place.
  - (Phase 2, planned: message bubbles with reactions/threading, a channel
    sidebar for communities — the pi-atelier-shaped UI.)
- `demo.ts` — standalone smoke test; run `node dist/demo.js` in a real
  terminal to verify the engine renders before trusting production wiring.

## History: how we got here (three attempts, keep this)

1. **Adopt pi-tui + keep readline** (`0811d6d` → `9285628`, reverted in
   `c165cf1`): pi-tui's `ProcessTerminal` and `readline.Interface` both
   claim raw mode on `process.stdin` for their entire lifetimes. Two
   independent raw-mode owners in one process don't coexist — confirmed
   live, piped input silently dropped mid-call.
2. **Build our own, never touch raw mode** (`77bd723` → `73ab26c`): plain
   ANSI escapes coexisting with readline. Worked for a spinner and (after
   two rewrites) a trailing status line, but it's a dead end for the real
   goal — a sidebar/channels chat UI needs owned-terminal rendering.
3. **Adopt pi-tui, drop readline entirely** (current): one ownership model,
   the engine's. The old conflict is resolved by removal, not workaround —
   there is exactly one raw-mode claimant in the process. Harness
   subprocesses (`claude-agent-acp`, spawned with piped stdio in
   `src/harness.ts`) are unaffected: pipes are not the TTY fd.

The lesson that survives all three: **one stdin/stdout ownership story per
process.** Anything that writes to the terminal while the engine owns it
must go through the component tree — see `src/notices.ts` for how
mid-session warnings from non-TUI modules get routed into the chat log
instead of smearing stderr across the render.

## Constraints that still hold

- Rendering-layer only: routing/chaining/persona/harness/extension logic
  in `src/*.ts` doesn't belong in here.
- Verify live, not just typecheck — pipe real input through the real TUI
  (note: raw-mode Enter is `\r`, not `\n`; `printf '/quit\r' | node
  dist/cli.js` exits cleanly, `echo "/quit"` does not submit).
- pi-tui stays **pinned exact** — upgrades are deliberate, reviewed bumps,
  not `^` drift. If engine internals ever need changing, vendor at that
  moment (MIT permits it; the evaluation is in this repo's session
  history) rather than forking pre-emptively.
