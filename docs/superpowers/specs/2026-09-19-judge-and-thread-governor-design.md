# Judge endpoint and thread governor — design

Date: 2026-09-19. Status: approved in chat, implementing.

## Why

The hosted router already uses TypeSafe Jev, but only for one question
("which agent") through a chat-completions shape. Jev answers three
question types (choice, score, noul) in one call at ~200 ms for a
fraction of a cent. Fez spends a full generative agent turn on every
small judgment today, so it only judges when someone @mentions an agent.
This makes judgments cheap enough to run on every message.

Two slices, in order.

## 1. Foundation

### Gateway: `POST /v1/judge`

Lives in `deploy/router/gateway.mjs` next to routing. Same bearer key,
same per-IP limiter (raise `RATE_PER_MIN` by env on the box). Body is
TypeSafe's own shape and is passed through after validation:

- `state`: string, object, or array. Body under `MAX_BODY_BYTES`.
- `questions`: object, 1–32 entries. Each `{ type, instructions, criteria? }`
  with `type` in `choice | score | noul`; `choice` requires 2–255 criteria.
- No local fallback. Any failure is a 502/504; callers keep their
  current behavior.

Response is TypeSafe's `answers` and `usage` unchanged. Log one JSON
line per call: question names, latency, tokens. Never content or keys.

### Routing confidence

Routing responses gain `X-Fez-Router-Confidence`, and the existing
per-route log line already carries confidence and probabilities.

### Shared client (`packages/fez-orchestrator/src/typesafe.ts`)

- `judge(apiKey, state, questions, options)` — calls TypeSafe, validates
  the response strictly (model echo, per-type answer shape, usage).
- `chooseTypeSafeRoute` is reimplemented on top of `judge`.
- `askJudge(routerUrl, routerKey, state, questions, options)` — calls the
  gateway route with the same validation. The only import adapters need.

## 2. Thread governor (first adapter)

### Where

`packages/fez-acp/src/agent.ts`, right after the chain-depth loop guard
and before the turn is queued. Pure decision logic in a new
`packages/fez-acp/src/governor.ts`, tested from fez-evals.

### When it runs

Only for a plain mention from a fellow agent: the author is a verified
sibling, the event is not the owner's, not a `task` assignment to me,
and not a `result` (work-protocol events must complete). Owner messages
and work-protocol events are never governed.

### Questions (state = the scope's recent lines plus the trigger)

| name | type | statement |
|---|---|---|
| `needs_me` | noul | The latest message requires a substantive response from `<me>`; an acknowledgment or thanks does not count. |
| `resolved` | noul | The thread's task is complete or decided and no further agent action is needed. |
| `contradiction` | noul | The last two agent messages contradict each other on a matter of fact or a decision. |

### Decision

```
contradiction ≥ 0.8            → escalate: post one owner-tagged note, no turn
resolved ≥ 0.8 or needs_me < 0.3 → skip: log, no turn
otherwise                        → run the turn as today
judge error/timeout              → run the turn as today (fail open to current behavior)
```

Thresholds are constants with a `ponytail:` comment. Every decision is
logged as one JSON line (`governor`, values, outcome, latency) so the
thresholds can be calibrated from real traffic.

### Configuration

Mirrors the orchestrator: `FEZ_JUDGE_URL` / `FEZ_JUDGE_KEY`, falling back
to persona frontmatter `judge` / `judgeKey`. Unset means the governor is
off and nothing changes.

## Out of scope

Spend caps, per-workspace keys, wake-on-relevance for unaddressed
messages, replacing the depth cap (the governor sits in front of it, the
cap remains the backstop).

## Testing

- Gateway test: judge success (fake provider), malformed body rejected
  before any paid call, unauthorized rejected, confidence header on routing.
- Client test: `judge` response validation per type.
- Governor test: pure decision table, including fail-open on error.
