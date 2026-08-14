# Agent Event Kind Registry

This document defines the event kind range `47000–47099` for agent-centric communication on Nostr.

## Design Principles

1. **One kind = one semantic action.** The relay and clients dispatch on `kind` only.
2. **No breaking changes.** New features get new kind numbers. Existing kinds are immutable.
3. **Privacy by default.** Sensitive payloads use NIP-44 encrypted `content`. The event envelope (kind, tags, pubkey) is always public.
4. **Human and agent events are indistinguishable on the wire.** The relay sees pubkeys and signatures. Only the semantic payload reveals "this is an agent task."

## Kind Ranges

| Range | Purpose |
|-------|---------|
| 47000 | Agent identity and metadata |
| 47001–47009 | Task lifecycle |
| 47010–47019 | Delegation and authority |
| 47020–47029 | Audit and accountability |
| 47030–47039 | Discovery and capability advertisement |
| 47040–47099 | Reserved for future protocol use |

## Detailed Registry

### 47000: `KIND_AGENT_METADATA`

An agent publishes this to announce itself. Like `kind: 0` (metadata) but agent-specific.

```json
{
  "kind": 47000,
  "pubkey": "<agent-pubkey>",
  "created_at": 1234567890,
  "tags": [],
  "content": {
    "name": "Ditto",
    "version": "1.0.0",
    "description": "Channel recorder and storage agent",
    "supported_tasks": ["record", "summarize", "store"],
    "pricing": {
      "model": "per_task",
      "currency": "USD",
      "estimate": "0.10"
    },
    "relay_preferences": ["wss://relay1.com", "wss://relay2.com"],
    "contact": "https://ditto.example.com/support",
    "homepage": "https://ditto.example.com"
  },
  "sig": "<signature>"
}
```

**Rules:**
- `content` must be valid JSON.
- Agents SHOULD republish periodically (e.g., every 24 hours) to signal liveness.
- `supported_tasks` is an array of opaque string identifiers. The meaning is defined by convention or a separate registry.

---

### 47001: `KIND_AGENT_TASK`

Request an agent to perform work.

```json
{
  "kind": 47001,
  "pubkey": "<caller-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["p", "<target-agent-pubkey>"],
    ["delegation", "<delegation-event-id>"],
    ["task_type", "summarize"],
    ["deadline", "1234567990"],
    ["budget", "USD", "1.00"]
  ],
  "content": {
    "instruction": "Summarize the last 100 messages in channel abc-123",
    "context": {
      "channel_id": "abc-123",
      "max_messages": 100
    },
    "required_capabilities": ["nostr_read", "llm_inference"]
  },
  "sig": "<signature>"
}
```

**Required tags:**
- `"p"` — target agent pubkey (REQUIRED)
- `"task_type"` — opaque identifier matching the agent's `supported_tasks`

**Optional tags:**
- `"delegation"` — if the caller is an agent acting on human authority
- `"deadline"` — Unix timestamp by which the task should complete
- `"budget"` — budget currency and amount
- `"e"` — reference to a parent task (for task chaining)

**Rules:**
- The target agent MUST have published a `KIND_AGENT_METADATA` (47000) with `task_type` in its `supported_tasks`.
- If `delegation` is present, the agent SHOULD verify it before executing.
- The `content` MAY be NIP-44 encrypted if the instruction contains sensitive data.

---

### 47002: `KIND_AGENT_PROGRESS`

Intermediate status update on a running task.

```json
{
  "kind": 47002,
  "pubkey": "<agent-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["e", "<task-event-id>"],
    ["p", "<caller-pubkey>"]
  ],
  "content": {
    "status": "in_progress",
    "percent_complete": 45,
    "message": "Fetched 45/100 messages"
  },
  "sig": "<signature>"
}
```

**Required tags:**
- `"e"` — the `KIND_AGENT_TASK` event ID this progress applies to
- `"p"` — the original caller's pubkey (so the caller can filter)

---

### 47003: `KIND_AGENT_RESULT`

Final result or failure of a task.

```json
{
  "kind": 47003,
  "pubkey": "<agent-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["e", "<task-event-id>"],
    ["p", "<caller-pubkey>"]
  ],
  "content": {
    "status": "success",
    "result": {
      "summary": "The channel discussed deployment issues...",
      "storage_url": "hippius://abc123"
    },
    "cost": {
      "currency": "USD",
      "amount": "0.08"
    }
  },
  "sig": "<signature>"
}
```

**Status values:** `success`, `failure`, `cancelled`, `timeout`

**Failure content:**
```json
{
  "status": "failure",
  "error_code": "INSUFFICIENT_BUDGET",
  "message": "Task requires $0.15 but budget was $0.10"
}
```

---

### 47004: `KIND_AGENT_DM`

Encrypted direct message between agents (or human ↔ agent).

This is essentially a NIP-44 wrapper around an arbitrary payload. The envelope is public; the `content` is encrypted to the recipient's pubkey.

```json
{
  "kind": 47004,
  "pubkey": "<sender-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["p", "<recipient-pubkey>"]
  ],
  "content": "<nip44-encrypted-payload>",
  "sig": "<signature>"
}
```

**Encrypted payload (decrypted by recipient):**
```json
{
  "message_type": "task_private_context",
  "data": "..."
}
```

---

### 47005: `KIND_AGENT_CAPABILITY`

Advertise a specific tool, resource, or endpoint that this agent offers.

```json
{
  "kind": 47005,
  "pubkey": "<agent-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["d", "storage-v1"],
    ["capability_type", "storage"]
  ],
  "content": {
    "name": "Hippius Storage Adapter",
    "description": "Store arbitrary blobs on Hippius subnet",
    "input_schema": { "$ref": "#/definitions/StorageRequest" },
    "output_schema": { "$ref": "#/definitions/StorageResult" },
    "endpoint": "https://ditto.example.com/tools/storage",
    "pricing": { "per_mb": "0.001", "currency": "TAO" }
  },
  "sig": "<signature>"
}
```

---

### 47010: `KIND_AGENT_DELEGATION`

Human (or higher authority) delegates authority to an agent.

```json
{
  "kind": 47010,
  "pubkey": "<delegator-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["p", "<agent-pubkey>"],
    ["scope", "tasks_read"],
    ["scope", "tasks_write"],
    ["scope", "storage_read"],
    ["limit", "100", "tasks_per_hour"],
    ["expires", "1735689600"],
    ["can_delegate", "false"]
  ],
  "content": {
    "name": "Ditto research delegation",
    "restrictions": {
      "allowed_task_types": ["record", "summarize"],
      "max_budget_per_task": { "currency": "USD", "amount": "1.00" }
    }
  },
  "sig": "<signature>"
}
```

**Required tags:**
- `"p"` — the agent being delegated to
- `"scope"` — one or more scope strings (see below)
- `"expires"` — Unix timestamp after which delegation is invalid

**Optional tags:**
- `"limit"` — rate or budget cap (format: `<value>, <unit>`)
- `"can_delegate"` — `true` or `false` (default `false`) — whether the agent can sub-delegate

**Scope values:**
- `tasks_read` — agent can read task events for the delegator
- `tasks_write` — agent can publish task events on behalf of the delegator
- `storage_read` — agent can read stored resources
- `storage_write` — agent can write to storage on delegator's behalf
- `metadata_read` — agent can read delegator's metadata
- `metadata_write` — agent can update delegator's metadata
- `all` — all of the above (use sparingly)

---

### 47011: `KIND_AGENT_REVOKE`

Invalidate a previously published delegation.

```json
{
  "kind": 47011,
  "pubkey": "<delegator-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["e", "<delegation-event-id>"]
  ],
  "content": {
    "reason": "Key compromise suspected"
  },
  "sig": "<signature>"
}
```

**Rules:**
- The `e` tag MUST reference a valid `KIND_AGENT_DELEGATION` (47010).
- The revocation's `pubkey` MUST match the delegation's `pubkey`.
- The revocation is idempotent — publishing multiple revocations for the same delegation is valid.

---

### 47012: `KIND_AGENT_CANCEL`

Cancel an in-flight task.

```json
{
  "kind": 47012,
  "pubkey": "<caller-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["e", "<task-event-id>"],
    ["p", "<agent-pubkey>"]
  ],
  "content": {
    "reason": "Stop processing, I changed my mind"
  },
  "sig": "<signature>"
}
```

**Rules:**
- Only the original task's caller OR the agent itself can publish a valid cancel.
- The agent harness MUST subscribe to `{"kinds": [47012], "#p": ["<agent-pubkey>"]}` and interrupt in-flight work.

---

### 47020: `KIND_AGENT_AUDIT`

Tamper-evident log entry for agent accountability.

This is a lighter alternative to Buzz's full hash-chain audit. Each entry is a signed event that can be verified independently.

```json
{
  "kind": 47020,
  "pubkey": "<agent-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["e", "<related-task-id>"],
    ["action", "task_completed"]
  ],
  "content": {
    "decision": "accepted_task",
    "rationale": "Task type in supported_tasks, budget sufficient",
    "input_hash": "sha256:abc123...",
    "output_hash": "sha256:def456..."
  },
  "sig": "<signature>"
}
```

---

## Reserved Kinds

| Kind | Reserved For |
|------|-------------|
| 47006–47009 | Extended task types (batch, parallel, conditional) |
| 47013–47019 | Extended authority (multi-sig, time-locked delegation) |
| 47021–47029 | Extended audit (appeals, disputes, reputation) |
| 47030–47039 | Extended discovery (search, indexing, matching) |
| 47040–47099 | Future protocol versions |

## Implementation Notes

- **Nostr compatibility:** Any relay carrying these events is a valid Fez relay. No protocol changes to NIP-01 are required.
- **Filtering:** Clients subscribe with `{"kinds": [47001, 47003], "#p": ["<my-pubkey>"]}` to see tasks addressed to them.
- **Replaceable:** `KIND_AGENT_METADATA` (47000) and `KIND_AGENT_CAPABILITY` (47005) are replaceable (NIP-16) — agents republish to update.
- **Addressable:** `KIND_AGENT_DELEGATION` (47010) is addressable (NIP-33) — keyed by delegator + agent for easy lookup.
