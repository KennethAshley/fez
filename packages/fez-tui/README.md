# fez-tui — adopt pi-tui as Fez's rendering engine

## Context (read this first)

Fez is a decentralized MCP for agents over Nostr — TypeScript SDK + CLI + a
terminal chat interface (`fez` with no args → `FezTUI` in `src/tui.ts`).
Full picture: read `AGENTS.md` and `docs/architecture.md` at the repo root
before touching anything.

The TUI currently works, is tested, and is in daily use — treat it as a
real product, not a prototype. It's built from plain pieces: Node's
`readline` for input, `console.log` for output, `chalk` for color, `ora`
for a spinner. It works, but every update prints a new line — there's no
in-place redraw, no real markdown rendering (agent replies print as raw
text), and the visual language doesn't match pi's.

## The ask

Replace Fez's ad-hoc rendering with **`@earendil-works/pi-tui`**
(`npm view @earendil-works/pi-tui` — real, published, MIT, on npm today),
the actual terminal UI library the `pi` coding agent itself is built on
(`https://github.com/earendil-works/pi/tree/main/packages/tui`). Not a
lookalike, not "chalk styled to look similar" — the real library, so Fez's
TUI ends up sharing pi's actual rendering engine (differential rendering,
real markdown, a real theme system) rather than approximating it.

This is a rendering-layer swap, not a logic rewrite. Everything about
*what* Fez's TUI does — recursive `@mention` chaining across personas and
harnesses, local harness dispatch via ACP, Nostr agent discovery — stays
as-is. Only *how it's drawn to the terminal* changes.

## The best reference you have: pi itself, installed and working

`@earendil-works/pi-coding-agent` is installed globally on this machine
and is the actual production consumer of pi-tui — read its source rather
than reverse-engineering pi-tui's API from type definitions alone:

```bash
which pi
# -> resolves into .../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
```

Find the real install path and read how pi itself assembles `TuiMainScreen`,
`VStack`, `Loader`, `Markdown`, and its theme into a working app — that's
your ground truth, not speculation. Also read pi's own docs shipped with
the package: `.../pi-coding-agent/docs/themes.md` documents the full
51-color theme token system pi-tui's `Markdown`/`Loader`/etc. consume, and
`.../pi-coding-agent/src/modes/interactive/theme/dark.json` and `light.json`
are pi's actual built-in theme values — use these, don't invent your own
palette from scratch.

## Key pi-tui pieces (confirmed present in `node_modules/@earendil-works/pi-tui/dist/*.d.ts` this session — verify current shape before relying on it, don't trust this list blindly)

- `TuiMainScreen` (`tui-main-screen.ts`) — renders into the terminal's
  **normal scrollback**, not an alt-screen/fullscreen takeover. This is
  the one you want — Fez's TUI should keep behaving like a normal shell
  session, not become a fullscreen app. (`TuiAltScreen` is the fullscreen
  alternative — don't use it unless explicitly asked.)
- `VStack` / `HStack` (`components/v-stack.ts`, `h-stack.ts`) — layout
  containers holding `Component`s.
- `Loader` (`components/loader.ts`) — pi's actual animated spinner.
  Constructor: `(ui: TUI, spinnerColorFn, messageColorFn, message?, indicator?)`.
  Replaces the current `ora` usage in `src/tui.ts`'s `routeToAgent()`.
- `Markdown` (`components/markdown.ts`) — full markdown renderer: headings,
  links, code blocks (with syntax highlighting hook), quotes, lists,
  tables, LaTeX. Constructor takes a `MarkdownTheme` (color functions per
  token — heading/link/code/quote/hr/etc., matching the token names in
  pi's `themes.md`). This is what should render agent reply content
  instead of the current raw `console.log(msg.content)`.
- `Editor` / `Input` (`components/editor.ts`, `input.ts`) — real text
  input widgets, with pi's own keybinding system
  (`keybindings.ts`, `TUI_KEYBINDINGS`). This is the highest-risk, most
  optional piece — see Phasing below.
- Core contracts: `Component`, `Container`, `TUI` (`tui.ts`) — what
  everything above implements/consumes.

## What's actually in `src/tui.ts` today (so you know what you're replacing)

- `Message` interface: `{ id, author, content, timestamp, status?,
  replyTo?, reactions? }` — this data model should NOT need to change;
  it's rendering-agnostic already.
- `FezTUI.routeToAgent()` — resolves a persona/harness/Nostr agent, drives
  the call, currently uses an `ora` spinner during work and calls
  `printReply()` once for the final message. This is the main integration
  point: swap the `ora` spinner for pi-tui's `Loader`, and swap
  `printReply()`'s plain `console.log` for a `Markdown` component render.
- `handleAgentReply()` — recursive `@mention` chaining (an agent's own
  reply can trigger another agent, same mechanism as a human message).
  Reaction tracking (`addReaction()`) is data-only right now; the visual
  form is a short "✅ responding to @X" note in `printReply()` — a real
  TUI could render this as an actual reaction pill if pi-tui's component
  set supports something like that, worth checking.
- `renderMessage()` / `addMessage()` / `updateMessage()` /
  `recordMessage()` — current print-based rendering split (render vs.
  data-only update vs. silent bookkeeping). This whole split may collapse
  once there's a real component tree with differential rendering — a
  `VStack` of message components can just re-render itself rather than
  needing separate "did I already print this" bookkeeping.
- Input: `readline.createInterface(...)` in `start()`. Left alone unless
  you get to the optional Editor/Input phase.

## Constraints

- **Main-screen mode, not alt-screen.** Fez should keep scrolling in the
  user's normal terminal like it does today, not take over the whole
  screen like a fullscreen TUI app.
- **Don't touch the routing/chaining/persona logic.** `routeToAgent()`,
  `handleAgentReply()`, `parseMention()`, harness/persona resolution —
  none of that changes. If a refactor to adopt pi-tui seems to require
  changing that logic, stop and reconsider the approach rather than
  quietly changing behavior.
- **No fake/invented API.** Every pi-tui class/method you use must be
  something you've actually confirmed exists (read the `.d.ts` file or
  pi's own usage) — don't guess method names from vibes.
- **Verify live, not just typecheck.** This whole project has a strong
  norm (see recent git log) of proving things work by actually running
  them, not stopping at `tsc --noEmit`. Run the real TUI, screenshot or
  paste the actual terminal output, confirm it before calling anything
  done.
- **Keep `readline` unless you have a concrete reason not to.** Swapping
  input handling is high-risk (kitty protocol, IME, keybinding conflicts)
  for uncertain benefit — the render side (Loader + Markdown) is where
  the real visible improvement is.

## Suggested phasing

1. Get a minimal `TuiMainScreen` + root `VStack` mounted and rendering
   *something* — prove the plumbing works before porting real content.
2. Replace the `ora` spinner in `routeToAgent()` with pi-tui's `Loader`.
3. Replace `printReply()`'s raw text output with a `Markdown` component,
   themed from pi's actual `dark.json`/`light.json` values (or a
   Fez-specific palette inspired by them — your call, but ground it in
   the real tokens, don't invent one from scratch).
4. (Optional, separate decision) Editor/Input-based input, replacing
   `readline`. Only if 1-3 land cleanly and there's a real reason to.

## Also worth reading before starting

- `AGENTS.md`, `docs/architecture.md` — Fez's actual current architecture
  (TS end-to-end, no Rust, harness/persona/extension layers).
- `src/harness.ts`, `src/personas.ts`, `src/extensions.ts` — the systems
  `routeToAgent()` calls into; you don't need to modify these, just
  understand what they return.
- `packages/claude-code/` — an example of the existing sub-package
  convention in this repo, if `fez-tui` ends up wanting its own
  `package.json`.
