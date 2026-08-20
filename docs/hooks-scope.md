# Hooks + orphaned reaction cleanup — scope

Status: **proposal, not started.** Written 2026-08-20 from a read of
`packages/fez-acp/src/agent.ts` (the channel agent runtime) against Gas Town's
orchestration model (`gastownhall/gastown`).

Two changes, deliberately separable. **Part A ships alone and is worth doing
regardless of what happens to Part B.** Part B depends on nothing in Part A,
but Part A's fix becomes part of Part B's restart path, so doing A first is
the cheaper order.

---

## Background: how work is currently tracked

The live flow, as built:

1. Trigger arrives — channel mention, DM gift-wrap, or doc comment.
2. Admission: author gate, depth cap, dedupe by event id.
3. A single in-process `busy` flag guards the turn (`agent.ts:852`).
4. Overflow goes to per-scope FIFO queues — cap 20, drops oldest, batched on
   drain, retry ladder 5s → 30s → 120s then dead-letter (`agent.ts:854`).
5. On busy the default is *steer*: the new message is woven into the running
   turn rather than queued (`FEZ_AGENT_ON_BUSY=queue` restores queueing).
6. Status is kind-7 reactions — 👀 on accept, 💬 on turn start, both deleted
   when the turn ends (`agent.ts:1039`).
7. The permanent artifact is the reply message.

Restart recovery is at `agent.ts:1596`: the live subscription is `since: now`,
plus a 120-second backfill query that picks the **single most recent unanswered
mention** (`.at(-1)`), where "unanswered" means no `e`-tag reply marker from
the agent's own pubkey.

**The structural fact both parts of this document address:** everything that
decides what the agent does next lives in process memory. The relay holds the
trigger and the reply. Intent on restart is *reconstructed by inference*.

The steady-state design is good and is not in scope to change. The queue,
the batching, the steer path, and the retry ladder all stay exactly as they
are. What follows only concerns what happens when the process dies.

---

## Part A — orphaned status reaction cleanup

### The bug

`statusReactionIds` is a local array inside the turn handler
(`agent.ts:1044`). `clearStatusReactions()` publishes one kind-5 deletion
covering those ids when the turn ends (`agent.ts:1056`).

If the process dies mid-turn, that deletion never publishes. The 👀 and 💬
reactions stay on the triggering message permanently. The channel shows an
agent working on something that nothing is working on, and there is no
process left that knows those reaction ids.

The SIGINT handler (`agent.ts:1642`) clears the heartbeat interval, closes
sessions, and disconnects — it does not clear status reactions. A SIGKILL,
OOM, or laptop sleep certainly doesn't.

Note the asymmetry already present in the code: the typing indicator is
ephemeral kind-20002 and the comment at `agent.ts:1069` calls it "crash-safe
by design" because receivers expire it client-side and no stop event is
needed. Status reactions are stored kind-7 and got no equivalent treatment.

### The fix

On agent startup, before the backfill runs: query the agent's own kind-7
events in its channels, identify status reactions (the 👀/💬 status set, not
user-meaningful reactions), and publish a kind-5 deletion for any whose
target message the agent has since replied to — or, more simply, for any
older than a turn could plausibly still be running.

Constraints:

- **Only delete your own reactions.** Single-writer, same as Part B.
- **Only the status set.** An agent may legitimately react to things for other
  reasons; do not sweep those.
- Bound the lookback so startup cost stays flat.
- Fire-and-forget, matching the existing treatment — reactions are cosmetic
  and a failed cleanup must never block the agent from starting.

### Also in Part A: stop the backfill dropping work

Two changes at `agent.ts:1596`, both pure inference, no new stored state:

- `BACKFILL_WINDOW_S = 120` is too short. An agent down for three minutes
  never learns about the mention. Widen it, and make it configurable.
- `.at(-1)` takes only the most recent unanswered mention and silently
  discards the rest. Three people mention the agent while it is down and two
  are dropped with no trace. Take all unanswered mentions, oldest first, and
  enqueue them through the existing queue path so batching and dedupe apply.

The existing dedupe must be preserved. The comment at `agent.ts:1633` is
explicit about why: if the live subscription already delivered an event, a
second turn is exactly the bug.

### Why this stands alone

No new event kinds, no new state, no protocol change. It fixes a visible bug
today. If Part B is never built, this is still correct.

---

## Part B — the hook

### What it is

One replaceable event per agent, authored by that agent, recording what it is
currently working on. On restart the agent reads its own record instead of
guessing from recent channel traffic.

Today the agent *infers* what it owed you. A hook means it *wrote it down*.

### What inference gets wrong

Five failures readable off the current code:

1. **120s window** — outage longer than that loses the trigger entirely.
   (Part A mitigates, does not eliminate.)
2. **`.at(-1)`** — concurrent mentions silently dropped. (Part A fixes.)
3. **Reply-marker heuristic is wrong in both directions.** Work finished but
   answered in a doc, or via a tool side-effect with no channel reply, reads
   as unanswered → re-executed. A partial reply reads as answered → silently
   abandoned. (Part A does not touch this.)
4. **The queue evaporates.** Up to 20 items per scope, gone on crash, and by
   restart they are outside any sane backfill window. (Part A does not fix.)
5. **Orphaned status reactions.** (Part A fixes.)

Parts 3 and 4 are the residue that only a written record addresses. If, after
Part A ships, 3 and 4 do not hurt in practice, Part B can be declined and the
simpler system kept.

### The record

- **One record per agent**, replaceable, `d` = the agent's own pubkey.
- Content names the assignment: trigger event id, scope (`ch:<channelId>` /
  `dm:<pubkey>` / doc), channel id, accepted-at, attempt count.
- Cleared — not tombstoned into a status — when the turn completes.

### Invariants

These are the whole design. They are what keeps fez from needing Gas Town's
three-tier watchdog:

1. **Single writer.** Only the agent writes or clears its own hook. No
   external process ever mutates another agent's state. This is what makes
   the Zombie class (record and reality disagree, and a third party has to
   arbitrate) structurally impossible rather than merely monitored.
2. **Two write points only.** Accept, and clear. Not per-step, not per-tool.
   Every additional write point is a new way to diverge.
3. **Self-correcting on start, never reconciled externally.** A stale hook is
   resolved by its own agent on next startup — finish it, or explicitly
   abandon it and say so. Nobody else gets a vote.
4. **No recorded lifecycle states.** Do not store Idle / Working / Stalled /
   Done. Presence (20001), progress (47002), and hook-set already derive all
   four. Recording them is precisely what creates divergence — this is the
   mistake Gas Town's own `concepts/heartbeats.md` documents as a live bug
   (three heartbeat stores, a healthy agent escalated as stuck).

### Interaction with the existing backfill

The hook does not replace inference — it takes priority over it. Startup order:

1. Read own hook. If set, that is ground truth; act on it.
2. Then run the (Part A-widened) backfill for anything that arrived while
   down, deduped against whatever the hook just resolved.

The backfill remains the fallback for the one gap the hook cannot cover:
the agent died *between* accepting work and writing the hook.

### Case 4 is the design's load-bearing question

Crash *after* the work completed but *before* the hook was cleared.

The hook says working. The work is done. The agent cannot tell by inspection
which side is stale. This is the only state where the record and reality
disagree and no local evidence settles it.

Blindly re-running is unacceptable — the turn may have had side effects
(files written, messages sent, external calls). The proposed resolution is
that the agent **reports rather than re-runs**: it surfaces the ambiguity in
the channel and lets the human or the requester decide. That keeps the failure
loud and non-destructive.

**This needs a decision before implementation.** It is the single point where
this design can be unsound.

### Open decisions

- **Placement.** Core kind in `src/kinds.ts`, alongside presence (20001),
  status reactions, and turn metrics (47030)? Precedent says yes — a hook is
  agent runtime lifecycle, not a feature — and `packages/fez-acp/src/agent.ts`
  must write it at accept/clear, which no extension can reach today. The
  app-store constraint argues the other way, but honouring it would mean first
  building an extension seam into the turn loop. **Unresolved.**
- **Visibility.** A hook on the relay makes "what is this agent working on"
  queryable by anyone who can read it. That may be desirable (it is the
  precondition for fleet views) or may need encrypting to the owner, as turn
  metrics (47030) already are. **Unresolved.**
- **Case 4 resolution** as above. **Unresolved.**

### Explicit non-goals

Taken from Gas Town and deliberately refused:

- **No work-item database.** No beads, no Dolt, no second store. The relay is
  the store.
- **No watchdog tiers.** No Witness / Deacon / Dogs. Invariant 1 removes the
  need.
- **No central coordinator.** No Mayor.
- **No merge queue / Refinery.** Git workflow, not channel protocol.
- **No recorded lifecycle state machine.** See invariant 4.

---

## Test matrix

The relevant safety net is the vitest suite, **not fez-bench**.
`packages/fez-bench/src/core.ts` scores routing — selection accuracy,
over/under/mis-routes, p50 over router-hit cases. It would measure whether
hook history *improves* routing later; it cannot catch a hook that lies.

The right harness already exists. `packages/fez-evals/tests/mini-relay.ts` is
built for this: its docstring notes events persist across socket drops so "the
world kept moving while we were gone" is simulable by terminating only the
client's sockets, and `stop()/start()` fakes the relay itself going away.
`membership-recovery.test.ts` is the model to follow — a state-loss recovery
regression with the post-mortem written into the header.

This is the substantive reason to believe fez can carry a hook where Gas Town
struggles: their ground truth is tmux panes and worktrees on a filesystem;
fez's is signed events on a killable in-process relay. Divergence here is
testable.

| # | Scenario | Assert | Part |
|---|----------|--------|------|
| 1 | accept → crash mid-turn → restart | resumed **exactly once**, not twice | B |
| 2 | accept → complete → clear → restart | no phantom resume | B |
| 3 | crash *between* accept and hook write | falls back to backfill inference | A + B |
| 4 | crash *after* work done, *before* clear | reports, does not blindly re-run | B |
| 5 | stale hook from dead process, new one live | single-writer invariant holds | B |
| 6 | crash mid-turn → restart | stale status reactions cleaned | A |
| 7 | three mentions during outage | all three picked up, none dropped | A |
| 8 | outage longer than old 120s window | trigger still recovered | A |
| 9 | live subscription already delivered event | backfill does not double-fire | A (regression) |

Case 9 guards existing behaviour that the Part A backfill change could break —
`agent.ts:1633` calls the double turn "exactly the bug".

---

## Suggested order

1. Part A, with tests 6–9. Ships independently, fixes a live bug.
2. Settle the three open decisions — placement, visibility, case 4.
3. Part B, with tests 1–5.

Part B's payoff is not primarily crash recovery; Part A recovers most of that.
It is that fleet state becomes **queryable** — the precondition for
capacity-aware dispatch (`fez-sentinel` currently has no global spawn ceiling,
only per-persona dedupe at `packages/fez-sentinel/src/index.ts:269`) and for
routing on completion history rather than self-description. Build it when
those are wanted.
