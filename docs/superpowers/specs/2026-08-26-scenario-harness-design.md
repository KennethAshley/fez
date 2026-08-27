# Multi-Agent Scenario Harness — Design

**Date:** 2026-08-26
**Status:** Approved design, ready for implementation planning

## Problem

Fez has three test layers and a hole between them.

- `@fezchat/evals` — 700+ deterministic regression tests over the wire, crypto,
  git, and cold start. No real models, no concurrency, no GUI.
- `packages/fez-desktop/tests/e2e` — Playwright walks of onboarding flows
  against a real relay. One user, one flow, no agents talking.
- `@fezchat/bench` — grades the router's *judgment* on a frozen battery.

Nothing exercises **many real agents talking at once**. At launch, users will
stress fez with exactly that: multi-party discussions, deep threads, comments,
mention storms, edits and deletions mid-turn, and media. The failure modes that
matter there — two agents locked in a reply loop, a reply that orphans its
thread under load, a GUI that drops events during a burst — are invisible to
every layer above.

A second gap surfaced while scoping. `packages/fez-media/src/blossom.ts` maps
`mp4`, `mov`, `mp3`, and `wav` mimes, but `packages/fez-desktop/src/App.tsx:3095`
renders images only. Audio and video arrive as bare links, and no voice capture
path exists anywhere. Voice and video are a product gap, not merely a test gap.

## Goals

- One scenario definition runs two ways: headless in CI, and in the real app
  with a browser attached.
- Pass/fail is structural, never prose — deterministic under nondeterministic
  models.
- The same scenarios run against stub agents (free, every push) and against the
  real cast of claude-code, chutes, and pi (deliberate, before a release).
- Cross-harness participation is measured directly: does a chutes-hosted model
  obey fez's wire the way claude-code does?

## Non-Goals

- The audio/video render path and voice capture. Documented as a launch gap and
  pinned by scenario #9; not built here.
- LLM-judged answer quality. That is `@fezchat/bench`'s question.
- Throughput or load testing beyond ~5 agents and ~500 messages. This proves
  correctness under concurrency, not scale.
- A product-side loop guard, even if scenario #5 proves one is needed. That is a
  follow-up with its own design.

## Architecture

A new private package, `@fezchat/scenarios`, exporting three things:

- `SCENARIOS` — scenario definitions, as data.
- `runScenario(scenario, { relayUrl, tier })` → `Outcome`. Spawns the roster,
  plays the script, collects the full event graph and per-agent timing.
  **It does not assert.**
- `checkInvariants(outcome)` → `Violation[]`. Pure functions over an `Outcome`.

That split is the whole design. Because `runScenario` returns data and
`checkInvariants` is pure, two consumers can share one scenario:

- `packages/fez-evals/tests/scenarios.test.ts` runs the CI subset headless.
- `packages/fez-desktop/tests/e2e/scenarios.spec.ts` spawns the relay, attaches
  a Playwright-driven desktop as a member of the room, calls the same
  run-then-check, and adds the GUI-only invariants.

The GUI tier never re-implements a conversation. It joins one.

The primitives already exist. `packages/fez-evals/tests/cold-start-bootstrap.test.ts`
spawns the real `fez-relay` binary and drives it headless with `FezClient` and
`BrowserWire`; `packages/fez-desktop/tests/e2e/helpers/relay.ts` spawns the same
binary for the browser. A stub agent is a `FezClient` plus a scripted reply loop.

### Scenario shape

```ts
{
  id: "mention-storm",
  roster: [
    { as: "human",  kind: "driver" },
    { as: "scribe", kind: "stub", replyDelayMs: 200 },
    { as: "scout",  kind: "stub", replyDelayMs: 3000 },
    { as: "fez",    kind: "live", harness: "claude-code" }
  ],
  script: [
    { at: 0, from: "human", post: "@scribe @scout @fez all of you: status" },
    { at: 0, from: "human", post: "and again", repeat: 20, everyMs: 100 }
  ],
  invariants: ["one-reply-per-mention", "no-agent-loop", "thread-roots-valid",
               "turn-deadline:30s", "relay-dom-parity"],
  gui: true
}
```

`kind: "stub"` carries knobs for the failure shapes users actually produce:
slow, silent, duplicate-replying, replies-with-oversized-image, replies-to-self.
`kind: "live"` swaps a real harness into the same roster slot behind
`FEZ_LIVE=1` — same script, same invariants, different participant.

### Package layout

```
packages/fez-scenarios/          @fezchat/scenarios, private: true
  src/
    types.ts        Scenario, Roster, Script, Outcome
    scenarios/      one file per scenario, pure data
    stub-agent.ts   FezClient + scripted reply loop; failure knobs
    live-agent.ts   spawns a real harness into a roster slot
    driver.ts       runScenario() — spawns nothing it does not kill
    invariants/     one file per invariant, pure (Outcome) => Violation[]
    index.ts        runScenario, checkInvariants, SCENARIOS
```

Conventions follow `@fezchat/evals`: `private: true`, `type: module`, vitest,
`tsc --noEmit` as `check`.

## Invariants

Each is a pure function over an `Outcome`, named for the bug it catches.

### Conversation integrity

- `one-reply-per-mention` — every `KIND_CHANNEL_MESSAGE` p-tagging an agent
  draws exactly one reply from it. Catches the silent agent and the
  double-responder with one check.
- `no-agent-loop` — no unbounded cycle where A's reply mentions B whose reply
  mentions A. The most likely launch-day disaster: two agents, infinite
  politeness.
- `no-cross-talk` — an agent replies only in the channel and thread it was
  addressed in. Catches a harness that answers into `#general` after losing
  thread context.
- `turn-deadline:<n>` — every addressed agent produces something (reply,
  typing, error) inside n seconds. A stalled tool call currently looks identical
  to being ignored.

### Thread and event graph

- `thread-roots-valid` — every reply's e-tags resolve to existing events, the
  root marker is present, and depth matches the script.
- `ordering-stable` — the relay's ordering of a burst is total and identical
  across two subscribers.
- `edit-delete-coherent` — `MSG_EDIT` and `DELETION` land on events that exist
  and are authored by the editor, including when they arrive mid-turn.
- `reaction-targets-live` — `KIND_REACTION` never dangles on a deleted or
  nonexistent event.

### Media

- `blob-resolves` — every posted media URL returns 200 and its sha256 matches
  the content-addressed name.
- `unsupported-media-degrades` — an mp4 or wav posts as a labeled link, not a
  broken bubble or an exception. This invariant pins the known gap in place so
  it cannot rot into a crash.

### GUI (only when Playwright is attached)

- `relay-dom-parity` — after quiesce, the set and order of messages in the DOM
  equals what the relay holds. One assertion catching dropped events,
  duplicated bubbles, and lost ordering.
- `console-clean` — zero errors and zero unhandled rejections across the run.
- `scroll-anchored` — a burst arriving while the user is scrolled up does not
  yank them down; one arriving at the bottom does follow.
- `render-bounded` — re-renders per incoming message stay under a threshold.
  Catches the accidental O(n^2) that only appears at 500 messages.

Two honest notes. `render-bounded` requires a re-render counter in the app
behind a test flag — the only invariant that touches product code. And
`no-agent-loop` verifies a guard that already exists rather than exposing a
missing one; see "Existing loop guards" below.

## Existing loop guards (what #5 actually tests)

fez already ships an agent-to-agent loop brake in four layers:

- **Chain-depth cap**, checked by the replying agent before it answers —
  `packages/fez-acp/src/agent.ts:1258`, and `:1696` for DMs. Human messages
  carry no `depth` tag (depth 0); each agent reply writes `trigger + 1`.
- **The same cap at the summoner**, so a sleeping agent is not woken into a
  loop — `src/agent/summon.ts:138`.
- **Turn budget**, 30/hour, `FEZ_AGENT_MAX_TURNS_PER_HOUR` — `agent.ts:640`.
- **Circuit breaker with cooldown**, self-mention exclusion, and a per-persona
  summon cooldown — `agent.ts:1602`, `summon.ts:145` and `:159`.

There is also a prompt-side rule that an `@` is a summons and not a courtesy
(`agent.ts:1433`) — the same fix Buzz landed for its runaway reply loop
(`docs/welcome-kickoff-silent-failures.md` §2, 2026-07-18). Buzz's reasoning
is worth preserving: "don't loop" is not a rule an agent can follow, because a
loop is a global property of a conversation while each turn looks locally
reasonable. The rule must become a local per-turn test. Buzz's own circuit
breaker remains unbuilt; what fez ships is what their doc lists as a candidate.

Scenario #5 therefore verifies a guard rather than exposing a missing one. It
targets two specific weaknesses:

1. **Cross-harness depth propagation.** The cap holds only because every reply
   copies `depth: trigger + 1` (`agent.ts:1367`). An adapter that drops the tag
   resets depth to 0 on every hop and the cap never trips. A chutes-hosted
   model is the likeliest offender, which is why #5 and #11 overlap.
2. **Constant drift.** `MAX_CHAIN_DEPTH = 5` is a copy-pasted literal in four
   places — `agent.ts:92`, `packages/fez-orchestrator/src/orchestrator.ts:71`,
   `src/cli/tui.ts:126`, `packages/fez-workflows/src/workflows.ts:49` — with no
   gate against drift, the same failure shape `kinds-registry.test.ts` exists to
   prevent.

Buzz's warning applies to any change here: a too-aggressive breaker manufactures
unexplained silence, which is a worse bug than the loop. Keep the cap high, and
log when it fires.

## Scenario matrix

CI = stub roster, every push. Live = real cast behind `FEZ_LIVE=1`, before a
release. GUI = Playwright attaches.

| # | Scenario | Stresses | Tier |
|---|---|---|---|
| 1 | `two-agents-one-room` | baseline: both mentioned, both reply, neither crosses | CI + GUI |
| 2 | `mention-storm` | 20 posts / 2s across 3 agents | CI + GUI |
| 3 | `deep-thread` | 40-deep reply chain, two agents alternating | CI + GUI |
| 4 | `slow-and-silent` | one agent 3s, one never answers | CI |
| 5 | `loop-bait` | A mentions B mentions A, unbounded | CI + Live |
| 6 | `delete-mid-turn` | human deletes the message an agent is answering | CI + GUI |
| 7 | `edit-storm` | rapid edits and reactions on messages being replied to | CI + GUI |
| 8 | `media-image` | agent posts image, blob resolves, renders | CI + GUI |
| 9 | `media-degrade` | mp4 and wav degrade to labeled links | CI + GUI |
| 10 | `doc-comments` | `DOC_COMMENT` thread with agents participating | CI |
| 11 | `cross-harness-parity` | claude-code + chutes + pi, one room, one prompt | Live |
| 12 | `two-clients-one-room` | two subscribers must agree on order | CI + GUI |
| 13 | `relay-drop-midturn` | relay dies while three agents hold in-flight turns | CI |

Three carry most of the weight.

**#11 `cross-harness-parity` is the centerpiece.** Three harnesses in one room,
one prompt, identical invariants. Not "whose answer is better" — that is bench's
question. This asks whether a chutes-hosted model *participates correctly*: does
it p-tag its reply, thread it right, stay in its channel, finish inside the
deadline. Expect failures here first: chutes models were never built to know
fez's wire, so the adapter around them does all the protocol work, and it is the
youngest code in the room.

**#5 `loop-bait` means different things per tier.** In CI, stubs are scripted to
loop and the test asserts the detector fires — that tests the invariant. In
live, real agents get the same bait and the test asserts they do not loop — that
tests the product. A live #5 failure is a launch blocker with no guard behind it.

**#13 has a cousin but is not one.** `packages/fez-evals/tests/reconnect.test.ts`
reconnects an idle subscriber. This kills the relay while three agents hold
in-flight turns, which is what flaky wifi actually produces.

Budget: the CI subset holds under roughly 90 seconds wall clock — stubs with
scripted latency, no inference, one relay per scenario. The live tier costs
minutes and money, and is run deliberately.

## Testing the harness

The harness must be trustworthy before it can accuse the product. Because
invariants are pure functions over an `Outcome`, each gets fixture tests both
ways: a hand-built outcome that violates it (must fire) and one that does not
(must stay silent). An invariant that cannot fail on demand is decoration. This
is the part written test-first.

The driver gets its own tests for process hygiene: every spawned relay and stub
is killed on both the pass and the throw path, and no scenario leaks a port or a
store directory into the next.

## Error handling

- A stub that fails to start fails the scenario immediately with the roster slot
  named — never a timeout thirty seconds later.
- A live harness that is unavailable (no `CHUTES_API_KEY`, binary missing) skips
  its scenario with an explicit skip reason. It never silently downgrades to a
  stub; a live tier that quietly ran stubs would be worse than no live tier.
- Invariant violations accumulate and report together. One run surfaces every
  broken invariant, not just the first.
- `runScenario` failing to reach quiesce inside a scenario-level ceiling is
  itself a reported violation, not a hang.

## Decisions left to the implementation plan

- Where the `render-bounded` re-render counter hooks into the desktop app. It
  lives behind a test flag and is the only product-code change this design
  requires; the hook point is a plan-level choice.
- `two-clients-one-room` (#12) attaches **one Playwright desktop plus one
  headless subscriber**, not two desktops. Ordering disagreement is a wire
  property, and one browser is enough to prove the GUI agrees with it.

## Follow-ups this design deliberately defers

1. Audio and video render path, plus voice capture. Launch gap, documented.
2. A registry gate for `MAX_CHAIN_DEPTH`, if the drift risk below is accepted.
3. Throughput and soak testing beyond this harness's ceiling.
