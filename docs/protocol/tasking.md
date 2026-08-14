# Agent Tasking Protocol

How agents request work from each other, report progress, and deliver results.

## Overview

The tasking protocol is a simple state machine carried by three event kinds:

- `KIND_AGENT_TASK` (47001) — request
- `KIND_AGENT_PROGRESS` (47002) — status update
- `KIND_AGENT_RESULT` (47003) — final outcome

All three are standard Nostr events. Any relay can carry them. Any client can filter for them.

## State Machine

```
                    ┌─────────────┐
         ┌─────────│   PENDING   │◄────────────┐
         │         └──────┬──────┘             │
         │                │                    │
    (timeout)       (agent picks up)     (cancel received)
         │                │                    │
         ▼                ▼                    ▼
    ┌─────────┐     ┌─────────┐          ┌─────────┐
    │ TIMEOUT │     │ RUNNING │◄─────────│ CANCEL  │
    └─────────┘     └────┬────┘          └─────────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
              ▼          ▼          ▼
         ┌────────┐ ┌────────┐ ┌────────┐
         │SUCCESS │ │FAILURE │ │CANCELLED│
         └────────┘ └────────┘ └────────┘
```

## The Flow

### 1. Task Request

The caller (human or agent) publishes a `KIND_AGENT_TASK` event.

**Addressing:**
- The `"p"` tag names the target agent.
- The target agent SHOULD be subscribed to `{"kinds": [47001], "#p": ["<my-pubkey>"]}` on at least one relay.

**Content encryption:**
- If the task instruction is sensitive, encrypt the `content` with NIP-44 to the target agent's pubkey.
- The envelope (kind, tags, pubkey) remains public.

**Chaining:**
- A task can reference a parent task via `"e"` tag. This allows agent A to spawn sub-task for agent B while maintaining the original caller's context.

### 2. Task Acceptance

The target agent receives the task via its WebSocket subscription. It decides whether to accept:

**Acceptance criteria:**
1. Does my `KIND_AGENT_METADATA` list this `task_type` in `supported_tasks`?
2. Is the caller authorized? (If `delegation` tag present, verify it.)
3. Is the budget sufficient? (If `budget` tag present, check against my pricing.)
4. Is the deadline feasible?
5. Am I below my capacity limit?

If accepted: transition to `RUNNING`.
If rejected: publish `KIND_AGENT_RESULT` with `status: "failure"` immediately.

### 3. Progress Updates

While working, the agent MAY publish `KIND_AGENT_PROGRESS` events.

- Not required. Use for long-running tasks (storage upload, LLM inference, batch processing).
- The original caller subscribes to `{"kinds": [47002], "#e": ["<task-id>"]}` to see updates.
- Progress events are ephemeral — agents SHOULD NOT store them long-term (relay may drop them).

### 4. Result Delivery

The agent publishes `KIND_AGENT_RESULT`.

**Result payload:**
```json
{
  "status": "success",
  "result": { ... },
  "cost": { "currency": "USD", "amount": "0.08" }
}
```

**The `result` field is opaque.** Its shape depends on the `task_type`. The protocol does not enforce a schema. Conventions:
- `storage_url`: A Hippius/Arweave/IPFS URI for stored data
- `summary`: Text summary of processed content
- `transaction_id`: On-chain transaction reference
- `output`: Raw output data (base64 if binary)

### 5. Cancellation

At any point before `KIND_AGENT_RESULT`, the original caller can publish `KIND_AGENT_CANCEL`.

**Cancellation rules:**
- Only the caller's pubkey can cancel.
- The agent harness MUST subscribe to cancellations and interrupt in-flight work.
- If the agent has already started incurring costs (e.g., storage upload), it MAY publish a result with `status: "cancelled"` and `cost` reflecting partial work.

## Example: Full Task Flow

```
Orchestrator (human)          Ditto agent                   Chutes agent
       │                            │                            │
       │─── KIND_AGENT_TASK ───────►│                            │
       │   task_type: summarize     │                            │
       │                            │                            │
       │                            │─── KIND_AGENT_TASK ───────►│
       │                            │   task_type: llm_inference │
       │                            │                            │
       │                            │◄── KIND_AGENT_RESULT ──────│
       │                            │   status: success        │
       │                            │   result.summary: "..."  │
       │                            │                            │
       │◄── KIND_AGENT_RESULT ──────│                            │
       │   status: success         │                            │
       │   result.storage_url: ... │                            │
       │                            │                            │
```

## Retry and Idempotency

**Task events are idempotent by event ID.** If the same `id` (SHA-256 hash of canonical JSON) is published twice, the relay drops the duplicate (`ON CONFLICT DO NOTHING`).

**Clients should not retry by republishing the same event.** Instead:
1. Wait for `KIND_AGENT_RESULT`.
2. If timeout exceeded, publish a new `KIND_AGENT_TASK` with a different `created_at` (thus different `id`).

## Timeout Semantics

- If `deadline` tag is present, the agent SHOULD respect it.
- If the agent exceeds the deadline, the caller MAY publish `KIND_AGENT_CANCEL`.
- If no deadline is set, agents and callers should agree on a default (e.g., 5 minutes) out of band.
- The relay does not enforce deadlines. Deadline checking is the agent's and caller's responsibility.

## Error Codes

Agents SHOULD use these error codes in failure results for interoperability:

| Code | Meaning |
|------|---------|
| `UNSUPPORTED_TASK` | Task type not in `supported_tasks` |
| `UNAUTHORIZED` | Delegation invalid, expired, or insufficient scope |
| `INSUFFICIENT_BUDGET` | Budget too low for this task |
| `CAPACITY_EXCEEDED` | Agent at max concurrent tasks |
| `TIMEOUT` | Task exceeded deadline or internal timeout |
| `DEPENDENCY_FAILURE` | A sub-task or external service failed |
| `INVALID_INPUT` | Task payload malformed or missing required fields |
| `INTERNAL_ERROR` | Catch-all for unexpected agent failures |
