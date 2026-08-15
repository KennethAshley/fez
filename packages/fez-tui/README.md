# fez-tui — a purpose-built chat-TUI library for Fez

## Context (read this first)

Fez is a decentralized MCP for agents over Nostr — TypeScript SDK + CLI + a
terminal chat interface (`fez` with no args → `FezTUI` in `src/tui.ts`).
Full picture: read `AGENTS.md` and `docs/architecture.md` at the repo root
before touching anything.

The TUI currently works, is tested, and is in daily use — treat it as a
real product, not a prototype. It's built from plain pieces: Node's
`readline` for input, `console.log` for output, `chalk` for color, `ora`
for a spinner. It works, but every status update prints a new line —
there's no in-place redraw, no real markdown rendering (agent replies
print as raw text), and it doesn't read like a chat app.

## The ask

Build `fez-tui` — a small, **Fez-owned** terminal rendering library for a
chat interface specifically. Not a general-purpose TUI framework, not a
dependency on someone else's library. Purpose-built for this one shape of
app: a scrolling message log, live "agent is working" status that updates
in place instead of spamming new lines, and readable rendering of agent
replies (at minimum: paragraphs and maybe bold/code — full markdown
parsing is a nice-to-have, not the point).

## Read this before writing any code: what already failed here, and why

This package's first attempt (see git log: `0811d6d`, `9285628`,
reverted in `c165cf1`/`326b937`) was "adopt `@earendil-works/pi-tui`
wholesale." It got as far as a working standalone proof — live-verified,
a real animated spinner, real markdown rendering — before failing when
wired into the actual production TUI.

**The failure, precisely:** pi-tui's `ProcessTerminal` puts `process.stdin`
into raw mode and attaches its own input listeners to drive differential
rendering. Node's `readline.Interface` (what `src/tui.ts` uses for the
`>` prompt) does the exact same thing to the exact same stream, for its
*entire lifetime* — not just while actively prompting. The two don't
coexist. Confirmed live: closing and recreating the `readline.Interface`
around each pi-tui-rendered turn (so their raw-mode claims never
overlapped *logically*) still weirdly, silently dropped piped input in
testing. Root-caused it was heading toward "two independent raw-mode
stdin owners in one process is fragile," not a bug in either library.

**What this means for `fez-tui`:** whatever you build must own input and
output through **one single stdin/stdout ownership story**, not two
things independently fighting for raw mode. Concretely, pick one:

- **(a) fez-tui owns everything** — replace `readline` too. One raw-mode
  claim, one component that both renders the message log *and* handles
  the input line, no handoff between two systems.
- **(b) fez-tui never touches raw mode** — do in-place redraw using only
  ANSI cursor-movement + `console.log`/`process.stdout.write` (same
  category of technique `ora` already used, successfully, for months in
  this exact codebase), and leave `readline` in exclusive control of
  stdin. No raw-mode conflict because there's only ever one claimant.

(b) is very likely the pragmatic choice — it's much smaller, and it's
proven to work in this codebase already (`ora`'s spinner has been doing
in-place terminal redraw via plain ANSI escapes + a stdout write loop,
coexisting with `readline`, this whole time, with zero conflicts). Don't
reach for raw-mode/differential-rendering machinery unless there's a
concrete feature that actually needs it — chat apps mostly don't.

## What "chat-like" actually requires, concretely

Looking at what's currently rough in `src/tui.ts`:

- **In-place status updates.** `routeToAgent()` currently prints a new
  `console.log` line on every progress tick while an agent works — a
  slow call produces 4+ near-duplicate "is working..." lines. Want:
  one line that updates itself (spinner + live text preview), the way
  `ora` already almost does, just needs a touch more control (e.g. also
  showing streamed tool-call activity, not just text chunks — see the
  "tool-call visibility" gap noted a few sessions back).
- **Clean message rendering.** Currently: `console.log(color(name));
  console.log(content)` — a bold name header then raw content. That's
  already decent (see git log `3487bc8`) but has zero markup awareness —
  a reply with `**bold**` or a ` ```code block``` ` in it prints the
  literal asterisks/backticks.
- **Reactions/threading data already exists, isn't rendered richly.**
  `Message.reactions` / `Message.replyTo` are tracked (see `c165cf1`'s
  predecessor commits) but only surface as a one-line "✅ responding to
  @X" note. A real chat-shaped renderer could do more with this if it's
  cheap.

None of this needs pi-tui's differential rendering, kitty image protocol,
LaTeX, or a 51-token theme system. Scope tightly.

## Constraints

- **Don't touch the routing/chaining/persona logic.** `routeToAgent()`,
  `handleAgentReply()`, `parseMention()`, harness/persona resolution in
  `src/harness.ts`/`src/personas.ts` — none of that changes. This is a
  rendering-layer project only.
- **Coexist with (or replace) `readline` deliberately** — see above. Don't
  bolt something new onto the side of the existing input loop without
  picking (a) or (b) explicitly and following through.
- **Verify live, not just typecheck.** This whole project has a strong
  norm (see git log) of proving things work by actually running them —
  pipe real input through the real TUI, read the raw output, confirm
  before calling anything done. The previous attempt's failure was only
  caught because it was tested this way, not assumed from a clean
  `tsc --noEmit`.
- **No new dependency without a concrete reason.** `chalk` and `ora` are
  already proven in this codebase. Reach for something new only if
  there's a specific thing neither can do that's actually needed.

## Also worth reading before starting

- `AGENTS.md`, `docs/architecture.md` — Fez's current architecture (TS
  end-to-end, no Rust, harness/persona/extension layers).
- `src/tui.ts` — what exists today: `Message` model, `routeToAgent()`,
  `handleAgentReply()`, the current `ora`+`chalk`+`console.log` rendering.
- `src/harness.ts`, `src/personas.ts`, `src/extensions.ts` — systems
  `routeToAgent()` calls into; understand what they return, don't modify.
- `packages/claude-code/` — existing sub-package convention in this repo,
  if `fez-tui` ends up wanting its own `package.json`.
