# Agent payments — cross-owner TAO, testnet mode, zap-shaped receipts

**Date:** 2026-08-26 · **Status:** draft for review · **Scope:** `@fezchat/wallet` only. No core protocol code changes beyond two kind constants; no service integration; no mining.

## Problem

`wallet_send` can pay any agent whose key you already hold — `resolveTo`
(`packages/fez-wallet/src/tools.ts:52`) turns a local store entry into its
address. It cannot pay an agent it does not hold, which is every agent
belonging to anyone else. Agents in the same channel, visible to each other by
npub, have no way to move value between them.

Three things are missing, and they are separable:

1. **Resolution.** A payer has a name and an npub; it needs an SS58.
2. **A safe place to play.** Testnet today is a hand-edit of `endpoints.tao`
   with one ledger shared across both chains, so an experiment pollutes the
   record you would read for a real spend.
3. **A trace.** Substrate transfers carry no memo. Once TAO moves, nothing
   anywhere connects the payment to the message that earned it — the payee
   sees a balance change and no story.

## Decision

The wallet publishes where its agent can be paid, resolves names to addresses
through a fall-through chain that never blocks, keys its local state by
network, and publishes a chain-verifiable receipt bound to the message a
payment was for.

The wallet's job stays exactly what it is: **take an address, move TAO.** It
never stores or configures anyone else's address. Whoever owns a relationship
owns its address.

---

## 1. Resolution — a fall-through, never a gate

`wallet_send`'s `to` is tried in order and falls through to today's behaviour:

| `to` | resolved by | proof of delivery |
|---|---|---|
| a local store entry (`chip`) | your own wallet — unchanged | chain |
| a channel-roster name (`@chip`) | their published address event (§2) | chain — the receipt (§4) |
| a name an installed extension claims | that extension | the service's own API |
| anything else | **passed through as a raw address** | chain |

**The fall-through is load-bearing.** A name the wallet does not recognise is
passed to the chain verbatim, exactly as today. The resolver adds names; it
never removes the raw-address path. A tier that could *refuse* an address
would be the thing that breaks paying for something we have not integrated
yet — Chutes, Hippius, an address a human pasted. The only gate on a send is
the consent threshold, which is a question about **amount**, plus the
new-payee card (§5), which is a question about **whom**. Neither is an
allowlist.

**Remote resolution** is: `@chip` → pubkey → address event.

- Pubkey comes from the kind-`47000` agent announces visible in the channel
  the wallet is configured against (`consentChannel`). The wallet already
  holds `read:channels` and a NIP-42-authenticated relay connection
  (`poolRelay`, `src/mcp.ts:76`).
- **Name lookup is scoped to that channel's roster, and ambiguity is an
  error.** Two owners may both run an agent called `chip`. When more than one
  roster member announces the same name, the send fails and names the
  candidates by npub; it never picks. A name is not an identity — the npub is.
- A leading `@` is optional and stripped; `@chip` and `chip` resolve alike,
  with the local store still winning (an agent you hold keys for is
  unambiguous).

**The extension-declared tier is a documented seam in this spec, not code.**
Its contract: an installed extension may claim a payee name and supply the
address at send time from its own authority — for Chutes that is
`GET /users/me` → `payment_address`, which is the account's coldkey and is
never configured by hand. The same extension confirms its own credit
(`/payments`, `balance`), because a service payment has no message to bind to
and no npub to tag; its proof of delivery is the service saying so. Hippius'
billing model is unknown at the time of writing and is deliberately not
guessed at. Nothing in this spec hardcodes any service address.

## 2. The address event — kind `30175`

Published by the wallet, signed by the **agent's own nostr key** — the same
key it already uses to sign consent requests (`readAgentNostrKey`,
`src/store.ts`). The wallet MCP holds it; `fez-acp`, which publishes the
`47000` announce, cannot read the wallet keychain. That is why this is the
wallet's own event and not a field on the announce.

```
kind: 30175                       (addressable — self-replacing)
tags:
  ["d", "tao:test"]               chain:network — one address per pair
  ["chain", "tao"]
  ["network", "test"]             "test" | "finney"
content: "5F3sa2…"                the SS58
```

Addressable (30000–39999 per NIP-01) because the useful query is "the current
address for this agent on this chain and network" — precedent in this repo is
`KIND_AGENT_ENGRAM` 30174, `KIND_READ_STATE` 30078. `30175` is free
(verified against `src/protocol/kinds.ts`).

**Publication is lazy and idempotent.** The event is published on the first
wallet tool call that needs a relay, never at MCP startup. This is the
`@polkadot` handshake trap that fez-bittensor already paid for once: heavy
work at startup cost the server its attachment to the harness. Republishing
is cheap and self-replacing, so no staleness bookkeeping is needed.

Trust: the address is claimed by the agent's own key. That is exactly as
strong as fez identity itself — an attacker who can sign as @chip can already
do worse than redirect @chip's income.

## 3. Network mode

```jsonc
// ~/.fez/wallet.json
{ "network": "test" }             // "test" | "finney"; default "finney"
```

`endpoints.tao` is derived from `network` and stops being the thing you edit:

| network | endpoint |
|---|---|
| `finney` | `wss://entrypoint-finney.opentensor.ai:443` |
| `test` | `wss://test.finney.opentensor.ai:443` |

An explicit `endpoints.tao` still wins, for a local node or a fork. Flipped by
`fez-wallet network <test\|finney>`; `fez-wallet network` prints the current one.

**Keys are untouched.** An SS58 is chain-agnostic; the same `//persona`
account exists on both chains with different balances. What gets namespaced is
everything that records history, so a play session cannot pollute the record
you would read for a real spend:

- `~/.fez/wallet-log.jsonl` → `wallet-log.<network>.jsonl`. The existing log
  holds 3 rows, all from the 2026-08-26 testnet e2e (verified), so migration
  is a one-time rename to `wallet-log.test.jsonl` — decided by that fact, not
  by reading the current config, which has since been pointed back at finney.
  A missing file reads as empty either way.
- The storage mirror gains a `network` field, and `log` becomes per-network,
  so the GUI panel shows one network's ledger at a time.
- `SpendEntry` gains `network`.

**The network guard.** A send is refused, before anything is signed, when the
payee's announced network differs from the sender's. This is the rule that
keeps a testnet session from touching real TAO — and it generalises for free
to service payees, which are mainnet-only. A raw address carries no network
and cannot be guarded; that is stated in the error path (§7), not silently
allowed to look safe.

`fez-wallet status` and the GUI Wallet panel both display the active network.
A non-`finney` network is visually marked — this is the one place where
looking wrong matters more than looking tidy.

## 4. Receipts — kind `47040`

A transfer that names the message it pays for publishes a receipt after the
block lands.

```
kind: 47040                       (regular — every payment is its own record)
tags:
  ["e", "<message being paid for>"]
  ["p", "<payee pubkey>"]
  ["h", "<channel>"]              so it lands in the room
  ["amount", "50000000"]          rao — integer, no float anywhere
  ["chain", "tao"] ["network", "test"]
  ["tx", "0x…"]                   extrinsic hash
  ["block", "0x…"]                block HASH (see below)
content: the memo, or ""
```

`47040` sits clear of the channel block (47100–47103) and the agent block; the
adjacent 47030 is `KIND_TURN_METRIC`. Free, verified.

`wallet_send` gains one optional argument, `for` — the id of the message being
paid for. The agent has this id; a human never types it. Omitted, everything
else works and no receipt is published: a plain transfer to a raw address is
still a plain transfer.

**Verification needs no indexer.** Substrate cannot look up an extrinsic by
hash alone, which is why the receipt carries the block. `transfer` already
settles at `r.status.isInBlock` (`src/chains/substrate.ts:145`), so
`r.status.asInBlock` yields the block hash at no cost — `ChainAdapter.transfer`
widens from `{ txHash }` to `{ txHash; blockRef?: string }`, the EVM stub
returning no `blockRef`. A verifier then does `chain.getBlock(blockHash)`,
finds the extrinsic by hash, and checks signer, destination and amount against
the receipt and against both parties' announced addresses. A forged receipt
fails that check.

**Known limitation, stated rather than hidden:** public endpoints prune, so a
block old enough to be dropped cannot be fetched. Such a receipt is
**unverifiable, which is not the same as invalid**, and the UI must
distinguish the two — an unverified receipt renders dimmed and says why; only
a receipt whose block *was* fetched and *did not* match is shown as false.
Anything that collapses those two states into one badge is wrong.

**Rendering** reuses the message decorator the wallet already ships for
consent cards: `⚡ 0.05 TAO · @scout` beneath the paid-for message, on every
participant's screen, because the receipt is an ordinary channel event.

**Receiving.** The payee's wallet treats a `47040` p-tagging it as an inbound
row in `wallet_history` — attribution the chain cannot provide. Inbound rows
are marked by verification state and are never trusted for accounting on the
strength of the event alone.

## 5. Consent

Unchanged: over-threshold sends post a `47103` request and wait for the
owner's ✅ (`src/tools.ts:88`). One addition:

**A first payment to a given remote payee always shows a card, regardless of
amount.** Approved once, that payee is remembered (`knownPayees` in
`wallet.json`, keyed by pubkey — not by name, which is not an identity) and
the threshold governs from then on.

The reasoning: the threshold answers *how much*, and a cross-owner send raises
*to whom*, which no amount can answer. It is a one-time cost per counterparty,
not a standing tax on tipping.

## 6. Files

| File | Change |
|---|---|
| `src/config.ts` | `network`, derived endpoint, `knownPayees` |
| `src/resolve.ts` | **new** — the fall-through chain; pure, injected lookups |
| `src/address-event.ts` | **new** — build/publish/query kind 30175 |
| `src/receipt.ts` | **new** — build/publish/verify kind 47040 |
| `src/tools.ts` | `for` argument, network guard, new-payee card, receipt publish |
| `src/log.ts` | per-network log file + `network` on `SpendEntry` |
| `src/storage-mirror.ts` | network field, per-network log |
| `src/chains/adapter.ts` | `transfer` returns `blockRef?` |
| `src/chains/substrate.ts` | return `asInBlock` hash |
| `src/cli-commands.ts` | `fez-wallet network [test\|finney]` |
| `src/gui.ts` | receipt decorator; network badge in the panel |
| `src/mcp.ts` | wire the new deps |
| `src/protocol/kinds.ts` (core) | `KIND_AGENT_PAYMENT_ADDRESS`, `KIND_PAYMENT_RECEIPT` |

`resolve.ts`, `address-event.ts` and `receipt.ts` are pure modules with
injected relay/chain access, testable without a relay or a chain —
`tools.ts` stays the wiring, and does not grow a fourth responsibility.

## 7. Errors

Every failure names the fix, and none of them fail silently:

- Payee has published no address → *"chip hasn't published a TAO address"*.
- Name is ambiguous in the roster → both npubs listed, nothing sent.
- Network mismatch → *"you're on test, chip is on finney"*, refused before signing.
- Raw address, network unknowable → allowed, and the consent card says the
  network could not be checked.
- Receipt publish fails after a successful transfer → the transfer **stands**,
  the local ledger records it, and the result text says the receipt did not
  publish. Money moving and the note about it are separate facts; never retry
  a transfer because an event failed.

## 8. Testing

Unit (vitest, injected fakes — no relay, no chain): resolution order and
fall-through, `@` handling, ambiguity, network guard, address-event
round-trip, receipt build/verify including the tampered-receipt and
pruned-block cases, per-network log routing, `knownPayees` promotion.

**The gate is a two-machine testnet run**, in the shape of the existing README
runbook: both wallets on `test`, both agents publishing addresses, a tip from
one owner's agent to another's — card approved, transfer lands, bolt appears
on *both* screens, both ledgers reconcile to the chain. Then the failure
paths: an agent with no address, a network mismatch, an ignored card.

Per repo convention, no real-TAO run until the testnet runbook passes end to
end.

## 9. Non-goals

- **Mining / registration.** `burnedRegister`, hotkeys under a coldkey,
  recurring burn and emissions — a different extrinsic family and a different
  lifecycle. It lands behind `ChainAdapter` later; `//persona` derivation
  already gives the coldkey/hotkey shape it will want.
- **Service integration.** Chutes and Hippius have no payment code today. The
  seam is written down (§1); neither package is touched.
- **EVM.** The stub stays a stub.
- **Escrow, invoices, streaming payments.** A payment here is a transfer plus
  a note about it. The bazaar's labour market builds on receipts; it is not
  this spec.

## 10. Risks

- **Block pruning** limits receipt verification to a window (§4). Mitigated by
  reporting unverifiable honestly rather than by adding an indexer.
- **Name/roster drift** — an agent leaving a channel becomes unresolvable by
  name. Correct: the npub, which the payer can still use as a raw address,
  is the identity.
- **Testnet TAO acquisition** is a faucet with a proof-of-work step and is not
  automated here; the runbook documents it.
- **Sub-threshold auto-sends to raw addresses** remain possible by design
  (§1). The balance is the cap — an agent talked into a hex string can lose
  its allowance and nothing more. That is the property the whole wallet is
  built on, and this spec does not weaken it.
