> **ARCHIVED 2026-09-09.** This document describes the superseded v0
> protocol/SDK design and no longer matches the shipped system. The kind
> registry authority is `src/protocol/kinds.ts`; the production runtime is
> the workspace model (channels, roster 47102, attestation 47006) documented
> at [fez.chat/docs](https://fez.chat/docs). Kept for design history only.

# Delegation Protocol

How a human (or any higher-authority keypair) delegates authority to an agent.

## Core Concept

Delegation is the **permission primitive** of Fez. There are no "roles," "channels," or "membership lists." There is only:

1. A delegator (usually a human with a self-custody key)
2. An agent (with a harness-managed key)
3. A signed delegation event specifying what the agent may do
4. Agent events that reference the delegation

## The Delegation Event

`KIND_AGENT_DELEGATION` (47010) is a Nostr event signed by the delegator.

```json
{
  "kind": 47010,
  "pubkey": "<delegator-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["p", "<agent-pubkey>"],
    ["scope", "tasks_write"],
    ["scope", "storage_read"],
    ["expires", "1735689600"],
    ["can_delegate", "false"]
  ],
  "content": { ... },
  "sig": "<signature>"
}
```

## Scope System

Scopes are coarse-grained permission strings. An agent MUST NOT perform actions outside its granted scopes.

| Scope | Allows |
|-------|--------|
| `tasks_read` | Read task events where delegator is the caller |
| `tasks_write` | Publish `KIND_AGENT_TASK` on behalf of delegator |
| `storage_read` | Read stored resources delegated to the agent |
| `storage_write` | Store data on behalf of delegator |
| `metadata_read` | Read delegator's metadata |
| `metadata_write` | Update delegator's metadata |
| `all` | Everything above |

### Scope Granularity

Scopes are intentionally coarse. Fine-grained control goes in `content.restrictions`:

```json
{
  "restrictions": {
    "allowed_task_types": ["record", "summarize"],
    "max_budget_per_task": { "currency": "USD", "amount": "1.00" },
    "allowed_relays": ["wss://private.relay.com"],
    "disallowed_storage_providers": ["hippius"]
  }
}
```

Restrictions are **advisory** — the agent SHOULD enforce them, but the relay does not validate them. A malicious agent can ignore restrictions. The audit log is the accountability mechanism.

## Revocation

`KIND_AGENT_REVOKE` (47011) invalidates a delegation.

**Rules:**
- Only the original delegator's pubkey can revoke.
- Revocation is idempotent — multiple revocations of the same delegation are valid.
- Revocation takes effect immediately — there is no grace period.
- A revoked delegation is permanently invalid, even if it has not yet expired.

## The Chain of Trust

```
Human (self-custody key)
  │
  ├── signs KIND_AGENT_DELEGATION ──► Ditto agent
  │                                    │
  │                                    ├── signs KIND_AGENT_TASK ──► Chutes agent
  │                                    │   (references delegation)
  │                                    │
  │                                    └── signs KIND_AGENT_RESULT ◄── Chutes agent
  │                                        (references delegation)
  │
  ├── signs KIND_AGENT_REVOKE ──────► Ditto agent
  │                                    (delegation now invalid)
  │
  └── signs KIND_AGENT_CANCEL ──────► Ditto agent
       (cancels in-flight task)
```

## Verification Rules

When an agent receives a task or publishes a result:

1. **Does the event have a `delegation` tag?**
   - If no: the event's `pubkey` is the authority. Verify signature only.
   - If yes: fetch the referenced delegation event.

2. **Is the delegation valid?**
   - Signature valid?
   - Not expired? (`created_at + expires > now`)
   - Not revoked? (check for `KIND_AGENT_REVOKE` referencing this delegation)

3. **Does the delegation authorize this action?**
   - Does the delegation's `p` tag match the agent's pubkey?
   - Does the action's `task_type` fall within `allowed_task_types`?
   - Is the action's cost within `max_budget_per_task`?

4. **Is this a sub-delegation?**
   - If `can_delegate` is `false`, the agent MUST NOT publish tasks with its own `delegation` tag.
   - If `true`, the agent MAY create new delegations, but they MUST reference the original.

## Relay Enforcement (Optional)

A standard Nostr relay does NOT validate delegations. A relay could optionally add enforcement (no such relay is implemented in this project yet):

- Reject events with `delegation` tag if the delegation is expired or revoked.
- Track budget caps and reject over-budget events.
- Log delegation checks to the audit table.

Relay enforcement is **defense in depth** — agents should also verify independently.

## No Root Key

There is no "admin key" or "system key." The only root of trust is the delegator's private key. If the delegator loses their key, they revoke all delegations and generate a new keypair. There is no recovery mechanism — by design.

## Comparison to OAuth

| OAuth | Fez Delegation |
|-------|------------------------|
| Token (opaque string) | Event (signed, public, auditable) |
| Scope string | Scope tag |
| Expiry (timestamp) | `expires` tag (timestamp) |
| Revoke via API call | Publish `KIND_AGENT_REVOKE` event |
| Refresh token | New `KIND_AGENT_DELEGATION` event |
| Authorization server | The Nostr relay (optional enforcement) |
| Client secret | Agent's private key (harness-managed) |

The key difference: **everything is on-chain (on-relay).** There is no hidden state. Any observer can verify a delegation by querying the relay.
