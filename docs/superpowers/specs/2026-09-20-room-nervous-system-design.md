# The room's nervous system: four more decisions move to Jev

**Thesis this serves.** Fez is chat with a team of agents where you never have
to manage the team. The room makes the coordination calls. Jev makes those
calls affordable (≈0.4 s, well under a cent), so they can happen on every
message instead of costing a model turn each.

**Already on Jev (2026-09-20):** who takes a mention; whether a sibling
message deserves a turn; whether a result satisfies the ask; whether an
owner question is needed; waking an agent without a visible summons.

**Still done by hand or by a static setting:** the four below. Each is a
snap judgment over named state, the shape Jev is built for. Each follows
the governor recipe: questions in `packages/fez-acp/src/governor.ts`, one
wiring point in `agent.ts`, every decision logged with its values,
fail-open to today's behavior on any judge problem.

## 1. Steer or queue (agent)

*Today:* `FEZ_AGENT_ON_BUSY` decides for every case. Default steer: any
mid-turn mention in the same thread aborts the in-flight turn and restarts
with the new message woven in — even "thanks!" or an unrelated aside.

*Decision:* state `{ in_flight, new_message }` (both message texts),
one noul: *does `new_message` change, correct, add to, or cancel the work
described in `in_flight`?* ≥ `STEER_AT` (0.7) → steer; below → queue (the
turn finishes, the message is handled next). Judge failure → steer, as now.

*Wiring:* the busy branch in `handleChannelMessage`. The in-flight trigger
is remembered when a turn starts (`activeTrigger`). The judge call is
awaited inside the branch; if the turn finished during the wait, the
message simply dispatches.

*Measure:* steers avoided, and the cost of the turns they would have
thrown away.

## 2. Failure escalation (agent)

*Today:* a failed turn posts "⚠️ I couldn't finish that" in the thread.
Nobody reads a thread they didn't start. Quill's provider returned 402
(no body) for an hour; the agent logged "provider down" and the owner
found out by asking why nothing came through.

*Decision:* on a FINAL failure (retries exhausted, or a non-retryable
class), state `{ agent, error, hint }`; one noul *is this something the
workspace owner can fix — billing, login, a key, a config — rather than a
passing outage?*; one choice `cause` ∈ {billing_or_quota, login_or_key,
provider_outage, harness_or_tool_bug, bad_input} for the wording. ≥
`ESCALATE_AT` (0.7) → one encrypted DM to the owner naming the agent, the
cause, and the fix. Same (agent, cause) is not repeated within an hour.
Judge failure → no DM (today's behavior); the channel notice stays.

*Plumbing gap, fixed alongside:* pi prints a bodiless 402 into its own
session log, not stderr, so the agent only sees "empty reply". The
provider failure surfaces as text the classifier can read, or the DM says
"empty reply from the provider" and points at the session log.

## 3. Attention routing (agent tag + desktop)

*Today:* the Home inbox lists every message p-tagged to you. Every agent
reply to your message is p-tagged to you by the thread rules, so the
inbox is every reply, handoff line included. Native notifications fire on
a literal `@you` only.

*Decision:* when an agent publishes a channel message, it tags it
`["attention", "now" | "later" | "none"]`. Templated posts are fixed:
handoffs `none`, chit-only acceptance posts nothing, owner questions
`now`. Model replies are judged: state `{ request, reply }`; noul
*does `reply` deliver something the asker (the owner) needs to read or act
on — an answer, a decision to make, a blocker — rather than an
acknowledgment or a step toward it?*; choice `urgency` ∈ {now, later,
none}. Judge failure → `now` (today's behavior: everything shows).

*Desktop:* `Msg.attention` from the tag. Home inbox shows `now` and
`later`, `now` first, and hides `none`. Untagged (older, or from agents
elsewhere) counts as `now`. A `now` row from an agent notifies as
`needs_action`; `later` does not.

## 4. Loop closure

Falls out of 3. A resolved thread produces no further `now` rows, an
accepted result already carries its chit, and the open-loops view keeps
deriving from unanswered approvals, questions, and running jobs. No new
object, no ticket to close — the conversation stays the record.

## Not in scope

Capability gating, packs, workflows beyond the silent wake, anything that
needs a new noun. Test for additions: does it make the conversation
between a person and their agents better.

## Verification

Governor tests per decision (wording pinned against recorded cases, as
today's completion rewording was). Live: one afternoon in #test with the
`{"governor": …}` log lines as the record.
