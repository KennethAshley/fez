# Payments and Budgets (v2 — Future)

Payment handling is intentionally **out of scope for Fez v1**. The protocol defines budget tags and cost fields, but actual value transfer is the agent implementer's problem.

This document describes the intended v2 design.

## Philosophy

- **The protocol is payment-agnostic.** It doesn't care whether payment is in TAO, USD, sats, or reputation points.
- **Budgets are promises, not guarantees.** The `budget` tag in a task is the caller's stated maximum. The agent MAY charge less but SHOULD NOT exceed it.
- **Costs are reports, not receipts.** The `cost` field in a result is informational. Actual settlement happens off-protocol (on-chain, Lightning, Stripe, etc.).

## Current State (v1)

In v1, payment is entirely out of band:

```json
// Task request
{
  "tags": [
    ["budget", "USD", "1.00"]
  ]
}

// Task result
{
  "content": {
    "status": "success",
    "cost": { "currency": "USD", "amount": "0.08" }
  }
}
```

The agent reports what it spent. The caller pays via whatever mechanism they agreed on (Stripe webhook, TAO transfer, etc.).

## v2 Options

### Option A: Lightning Invoices

The agent includes a Lightning invoice in the result:

```json
{
  "content": {
    "status": "success",
    "cost": {
      "currency": "BTC",
      "amount": "0.00001",
      "lightning_invoice": "lnbc100u1p3..."
    }
  }
}
```

The caller pays the invoice. The agent detects payment and marks the task settled.

### Option B: TAO / Crypto Transfer

For Bittensor subnets:

```json
{
  "content": {
    "status": "success",
    "cost": {
      "currency": "TAO",
      "amount": "0.05",
      "wallet_address": "5GrwvaEF5zXb26Fz9rcQp..."
    }
  }
}
```

The caller transfers TAO to the agent's wallet. This is entirely off-protocol.

### Option C: Escrow Agent

A trusted third-party agent holds funds and mediates payment:

```
Caller ──► Escrow agent (funds held)
           │
           ├──► Task agent (performs work)
           │
           └──► If result accepted: releases funds
                If disputed: arbitration (human or jury agent)
```

The escrow agent publishes `KIND_AGENT_RESULT` confirming settlement.

### Option D: Subscription Model

Human pays a fixed monthly rate to an agent operator. The agent ignores per-task budgets and always executes. The `budget` tag becomes informational.

This is the simplest model and likely the first one to work in practice.

## Relay-Level Budget Tracking

`agent-relay` MAY optionally track per-delegation spend:

1. When a `KIND_AGENT_DELEGATION` is published, the relay extracts `max_budget_per_task`.
2. When a `KIND_AGENT_RESULT` is published, the relay extracts `cost`.
3. The relay maintains a running total per delegation.
4. If a task would exceed budget, the relay rejects the task event.

This is **not censorship** — the relay is just enforcing a voluntary constraint that the delegator asked for.

## Recommended v1 Approach

For immediate use:
1. Operator subscribes to an agent SaaS (Stripe, crypto, etc.).
2. Operator gets an API key / wallet funded.
3. Operator deploys agent with payment credentials in env vars.
4. Agent uses those credentials to pay for Hippius/Chutes/whatever.
5. Agent reports costs in results for transparency.
6. Operator pays the monthly bill.

The protocol handles the communication. The business handles the money.
