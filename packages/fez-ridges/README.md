# @fezchat/ridges

The first paid-service extension for fez. `/ridges <issue-url>` pays the
[Ridges](https://ridges.ai) coding subnet, through your own wallet's
x402 rail, to turn a GitHub issue into a pull request. One payment, one
PR — and a bounty-rail pane that watches it happen.

```
fez install @fezchat/ridges
```

## Before you dispatch

Ridges only works a repo that has the **Ridgeline** GitHub app
installed on it:
https://github.com/apps/ridges-ai/installations/new

Dispatching against a repo without the app installed refuses before any
payment — the 404 it gets back names this install link, and that
`detail` is surfaced verbatim in the reply.

**Mainnet note:** Ridges charges on Base **mainnet**. Real payment logic
lives entirely in `@fezchat/wallet` (this package never touches keys,
caps, or consent) — flip the wallet's x402 network to mainnet when
you're ready to spend for real; ridges itself has no network setting of
its own to change.

## Use it

From any channel:

```
/ridges https://github.com/acme/widgets/issues/42
```

Or as an agent tool, `ridges_dispatch({ issueUrl, maxUsd? })` — same
underlying dispatch, same wallet caps and consent. `maxUsd` defaults to
**5**; big spends still ask you first.

A background poller checks GitHub every 90s for the PR your payment
bought, and transitions the job row honestly as it moves: `working` →
`pr-open` → `merged` or `closed`.

## The pane

Install adds a **ridges** rail entry (⛏) — live jobs on the left with a
spark riding the rail while the subnet works, done jobs below (merged,
closed, or payment-unclear), with each row's receipt.

## If a payment looks stuck

An `ambiguous`/payment-unclear outcome means the money may have
**already settled** — a paid-but-unclear response can't be told apart
from a lost one. **Do not re-dispatch the same issue.** Contact Ridges
support with the transaction hash from the reply (or the job row's
receipt) instead; retrying risks paying twice for the same issue.

## What this package does NOT do

No keys, no spend caps, no consent prompts — all of that is
`@fezchat/wallet`'s `x402FetchRaw`. No automatic rerun of a closed,
unmerged PR. No token support for a private repo Ridges/GitHub can't
read (that job's row just notes it and polling stops for that repo).
