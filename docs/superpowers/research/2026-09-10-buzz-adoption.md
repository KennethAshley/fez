# What Fez should adopt from recent Buzz changes

Research date: September 10, 2026. Scanned 127 commit subjects in the local Buzz
history from August 27 onward and inspected selected implementations against
Fez's current working tree. Buzz checkout: `051c3a270be9c73da9ab06700bcab7d5552fceaa`;
Fez base: `b2ca1c2`, with existing uncommitted work included in the comparison.
The public [Buzz commit history](https://github.com/block/buzz/commits/main/)
showed the same September 9 head when checked.

The initial research was source-only. Findings below describe that original
state; effort estimates are rough engineering estimates, not measured times.

**Implementation update — September 10:** Priority 1 is implemented in the
working tree: chat threads and document-comment threads own their sessions,
context, queues, retries, handoffs, and steering. DMs retain participant-based
sessions. The runtime still executes one turn at a time, keeps at most four live
sessions, and allows 20 queued events per channel across its threads. Activity
metrics keep their channel identifiers for desktop navigation. See the
[implementation plan](../plans/2026-09-10-conversation-isolation.md) for validation.

**Priority 2 implementation update — September 10:** Extension one-shot commands
and Claude auth probes now share a Rust runner that drains both pipes during
execution, enforces an aggregate output cap, and includes pipe completion in
the deadline. Oversized or unreadable output fails explicitly. Process-group
cleanup retains the leader's PID until termination. Extension commands retain
their 120-second limit with an 8 MiB output cap; auth probes use 10 seconds and
1 MiB. See the [bounded-commands plan](../plans/2026-09-10-bounded-commands.md).

**Priority 3 implementation update — September 10:** Channel history now has
per-channel loading/error state and a visible Retry control above the scrolling
conversation. Cached messages and partial results survive failures and retries;
failed reads no longer trigger the first-run empty-channel panel. The shared
transport exposes `queryWithStatus`, distinguishing actual EOSE from refusal,
CLOSED, disconnect, and timeout while preserving NIP-42 authentication and
per-filter request compatibility. Existing `query` callers retain their startup
connection retry window and best-effort event-array contract.

Older-history retries retain the original query boundary and advance from a
completed page, independently of cached partial outliers. A full page of messages
sharing one timestamp reports an explicit paging error; expanding dense timestamp
windows remains outside this change. Verification includes 17 focused evals,
root typechecking, client/desktop builds, and a real-browser recovery test with
40 messages that checks Retry visibility and prevents loss or duplication.
The full eval gate passed: **1,480 tests passed, one skipped**. No installed-app
update or deployment was performed.

**Priority 4 implementation update — September 10:** The user card displays a
shortened canonical npub, and the profile displays its full value. Both use the
same keyboard-accessible copy control, confirm only successful clipboard writes,
and preserve the distinction between identities when switching profiles during
a pending copy. A shared helper validates full hex keys before encoding through
the installed NIP-19 library; invalid values cannot be copied.

Desktop new-message, invite, and slash-command inputs also accept npubs, so
copied identities can be pasted back into Fez. They decode to hex before reaching
the client API. Malformed npubs and nsecs cannot fall through to name lookup or
local-persona invitations. Four focused evals cover encoding, decoding, invalid
input, lookalike names, and clipboard behavior. The browser check exercises both
profile surfaces, keyboard copying, pasted npubs, a signed workspace invite, and
rejection of a real test agent named after an invalid npub. Root typechecking
and the desktop build pass. The full eval gate passed: **1,484 tests passed,
one skipped**. This was validation before the main-branch integration; the
installed app was not updated.

**Main integration — September 10:** Priorities 1–4 are integrated with main
at `2a5128a`, retaining its workspace trust checks, question origins, runtime
refresh, and shared 100-conversation context cache. Queued corrections are
rechecked for revoked membership even when their original trigger is dropped.
Wiki replies recover omitted page metadata across channel moves. Sparse question
thread backfill cannot move ordinary pagination past a gap after a failed read,
and Retry keeps the selected thread.

Integration validation: core plus all 45 packages build, root typechecking passes,
the complete eval gate passes (**1,582 passed, three skipped**), both browser
flows pass, and native desktop tests pass (**80 passed, one ignored**). The two
additional review cases for revoked triggers and moved wiki replies also pass
in the 21-case conversation regression suite. No release version was changed.

## Ranked shortlist

| Priority | Adopt | Fez benefit | Rough effort |
|---|---|---|---|
| 1 | Conversation-scoped steering and sessions | Unrelated requests stop interrupting or contaminating each other | 2–4 hours for steering targeting; 1–2 days for full thread contexts |
| 2 | Bounded subprocess output and lifetime | No pipe-capacity stall during extension commands | About 1 day |
| 3 | Explicit history-load failure and retry | Offline/failed queries do not look like an empty channel | Half to one day |
| 4 | Canonical npub display and copying | Identity labels and copied values agree with Nostr tools | 2–4 hours for the first profile surfaces |
| 5 | Model-specific recovery notices | Users know how to recover from an unavailable model | 1–2 hours |

## First: isolate agent conversations

**Adopt the conversation-scoping rule from
[Buzz #6732](https://github.com/block/buzz/pull/6732), merged August 31.**
Buzz derives one scope when admitting an event and carries it through queues,
sessions, history, and interruption targeting. The optional thread policy gives
each channel thread its own session; the default remains channel-wide.
See [Buzz scope.rs](/Users/ken/Projects/buzz/crates/buzz-acp/src/scope.rs:107)
and [scope-targeted steering](/Users/ken/Projects/buzz/crates/buzz-acp/src/lib.rs:637).

There are two concrete Fez opportunities:

1. **Fix interruption targeting first — approximately 2–4 hours.**
   Fez's default busy path checks only that the active turn is a channel turn,
   adds the incoming message's text to a global steering list, and aborts the
   active turn. It does not compare the incoming channel or thread with the
   active one. Cleanup then redispatches the original trigger. Consequently,
   an admitted mention in channel B can be woven into the reply to channel A.
   This follows from the code; it was not reproduced against a running agent.
   See [admission and steering](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1519),
   [steering consumption](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1597),
   and [original-trigger redispatch](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1898).
   Carry an explicit active conversation identifier and queue unrelated work.
   Preserve event identity and document-comment metadata through deferral.
   Regression: an agent working in A receives a mention in B; B must not cancel
   A or enter A's prompt/reply, and B must subsequently receive its own answer.

2. **Give each thread its own working context — approximately 1–2 days.**
   Fez already has a bounded persistent-session pool, but calls it with
   `ch:${channelId}`; its recent-context cache and pending queues are also
   channel-keyed. Merely changing the session key would leave context and
   batching mixed. Resolve one scope using Fez's own event semantics and carry
   it through session lookup, recent history, queues, steering, retries, and
   memory handoffs. Keep the existing four-session cap and conversation-scoped
   DMs. Document comments need their own document/root identity.
   See [existing session pool](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1149),
   [context and queues](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1329),
   and [session lookup](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1773).
   Regression: two threads retain independent context; a follow-up reuses its
   own session; unrelated work queues fairly; replies retain the right root.

Buzz's September 4/8 follow-ups
[#7337](https://github.com/block/buzz/pull/7337) and
[#7340](https://github.com/block/buzz/pull/7340) address worker-affinity waits,
deadline wakeups, and stale session ownership after forks. Read these before
adding concurrent workers. Fez can retain its current single-active-turn model;
it does not need Buzz's worker-pool machinery to get conversation isolation.

## Bound extension subprocess output while it runs

[Buzz #6904](https://github.com/block/buzz/pull/6904), August 28, hardened runtime
discovery with bounded process execution and captured output.
See [Buzz's bounded command runner](/Users/ken/Projects/buzz/desktop/src-tauri/src/managed_agents/discovery/bounded_command.rs:1).

Fez's [run_extension_bin](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src-tauri/src/lib.rs:2301)
starts a child with piped stdout and stderr, polls for exit, and only then reads
the pipes. A sufficiently noisy child can fill a pipe and block before it can
exit, eventually reaching the 120-second timeout. The later reads are uncapped,
ignore read errors, and have no deadline if descendants keep the pipes open.
These are source-level failure paths; no extension was launched to reproduce them.

Adapt the principle with concurrent draining, bounded retained output, and a
deadline covering child execution and pipe completion. Keep draining discarded
bytes after a buffer limit, or terminate explicitly; merely stopping the reader
at the limit recreates the blockage. Output overflow must be explicit, especially
where callers parse stdout as JSON. Do not treat truncated JSON as success.
Test a child writing more than pipe capacity to both streams, and a descendant
holding a pipe open. The auth probe has a similar wait-before-read pattern
([probe_claude_auth](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src-tauri/src/lib.rs:667));
reuse the same small execution helper if changing both callers.

Estimate: about one day, including a focused Rust regression.

## Distinguish failed history loads from empty channels

[Buzz #7013](https://github.com/block/buzz/pull/7013), August 28, adds explicit
channel-history errors and Retry while retaining cached messages.
See [loading state](/Users/ken/Projects/buzz/desktop/src/features/messages/lib/timelineLoadingState.ts:74)
and [error card](/Users/ken/Projects/buzz/desktop/src/features/messages/ui/MessageTimelineErrorCard.tsx:1).

Fez's [connection wait](/Users/ken/Projects/Fez/fez/src/protocol/relay.ts:451)
returns after its deadline without reporting failure. Its query path calls
`querySync`, whose installed implementation resolves the collected event array
on close without exposing the close reason. Thus an unsuccessful query can
produce the same empty result as a successful query with no matching events.
See [Fez query](/Users/ken/Projects/Fez/fez/src/protocol/relay.ts:467),
[installed querySync](/Users/ken/Projects/Fez/fez/node_modules/nostr-tools/lib/esm/pool.js:996),
[desktop delegation](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src/wire.ts:149),
[history consumption](/Users/ken/Projects/Fez/fez/packages/fez-client/src/index.ts:2245),
and [channel opening](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src/App.tsx:789).

Preserve a query's completion/failure status at the shared transport boundary,
then show a per-channel load error and Retry while retaining available rows.
For multiple relays, retain partial results and report incomplete coverage;
one failed relay should not erase another relay's successful response. Audit
callers before changing the shared query contract.
Test offline failure, a genuinely empty successful response, partial relay
success, and recovery after retry. Estimate: half to one day.

## Display and copy actual npubs

Buzz's September 9 identity series
[#7488](https://github.com/block/buzz/pull/7488),
[#7489](https://github.com/block/buzz/pull/7489), and
[#7495](https://github.com/block/buzz/pull/7495) centralizes canonical npub
formatting and applies it to profiles, mentions, and agent controls.
See [Buzz's canonical npub helper](/Users/ken/Projects/buzz/desktop/src/shared/lib/pubkey.ts:39).

Fez's [UserCard](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src/UserCard.tsx:67)
currently renders the literal label `npub` followed by shortened raw hex. Its
[ProfilePane](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src/ProfilePane.tsx:56)
copies the raw hex key and displays it under `pubkey`. The latter is not an
incorrect label, but the two surfaces are inconsistent for users sharing an
identity with other Nostr tools.

Use the existing `nostr-tools` NIP-19 encoder through one shared formatting
helper. Keep internal event keys in hex, display a shortened real npub where
space is tight, and copy the full npub. Validate full input before encoding;
never convert a display abbreviation back into an identity. Start with these
two profile surfaces, then extend the same helper to other identity controls.
Estimate: 2–4 hours for the first surfaces and a focused UI check.

## Small runtime improvement: actionable model errors

[Buzz #7538](https://github.com/block/buzz/pull/7538), September 9, stops retrying
an unavailable model and posts instructions for changing the configuration,
saving, restarting, and resending.

**Fez already treats a plain model-not-found error as fatal:** unmatched errors
fall through to `fatal`, and only `transient` errors retry. The missing piece is
specific recovery guidance: the current hint only handles authentication.
See [classification](/Users/ken/Projects/Fez/fez/src/agent/harness.ts:879) and
[failure notice](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1844).
Adopt a small shared recovery-message mapping, with narrow model-error matching
and instructions verified against Fez's actual settings/restart flow.
Estimate: 1–2 hours. Test both the plain provider error and wrapped errors,
without changing transient network or stale-session handling accidentally.

## Already present, or not a direct transplant

- **Persistent sessions, retry queues, steering, and memory handoffs:** already
  explicitly Buzz-inspired in
  [Fez's standing runtime](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1149).
  Improve their boundaries rather than adding another runtime.
- **Verify relay events before handing them to agents**
  ([Buzz #7010](https://github.com/block/buzz/pull/7010), September 4): Fez uses
  `nostr-tools` SimplePool, whose installed implementation supplies signature
  verification and verifies received events before delivery. See
  [Fez subscription](/Users/ken/Projects/Fez/fez/src/protocol/relay.ts:356),
  [SimplePool default](/Users/ken/Projects/Fez/fez/node_modules/nostr-tools/lib/esm/pool.js:1126),
  and [verification before delivery](/Users/ken/Projects/Fez/fez/node_modules/nostr-tools/lib/esm/pool.js:573).
  The useful borrowing is malicious-relay regression coverage, not redundant
  verification code.
- **Capacity-paced overflow recovery**
  ([Buzz #7325](https://github.com/block/buzz/pull/7325), September 8): good design
  evidence, but its bounded socket-consumer queue is not Fez's implementation.
  Fez's task queue does drop its oldest item at 20 pending items
  ([queue cap](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1352)).
  If queue pressure is observed, start by making rejected/dropped work visible
  and recoverable. Do not copy a timestamp-watermark replay policy wholesale:
  Fez's [reconnection design](/Users/ken/Projects/Fez/fez/src/protocol/relay.ts:51)
  deliberately accommodates backdated NIP-17 gift wraps.
- **Codex adapter minimum version**
  ([Buzz #7427](https://github.com/block/buzz/pull/7427), September 9): a useful
  reminder to inspect the adapter's bundled runtime, but Fez's built-ins here
  are Claude Code and Pi
  ([registration](/Users/ken/Projects/Fez/fez/src/agent/harness.ts:977)).
  Buzz's exact Codex version floor is not a Fez fix.

Prefer small TypeScript adaptations at Fez's existing seams. Buzz's database,
multi-tenant authorization, and Rust agent runtime are different architectural
choices; none is required for these improvements.
