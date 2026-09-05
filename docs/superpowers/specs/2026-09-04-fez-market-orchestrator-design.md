# @fez Shops Its Own Bazaar — the market orchestrator, v1

*2026-09-04. Roadmap #8 ("how does someone pay @fez"), reshaped by two
decisions: @fez stays the trustworthy concierge — it advises and never
touches money — and the orchestration data it generates is the answer
to #7 (the corpus): every routing decision is a training tuple for the
orchestrator brain @fez eventually becomes. The broker-for-hire that
EARNS a spread on the public market is a separate, later character —
parked until strangers exist to hire it.*

## Thesis

@fez is the owner of the bazaar wearing a face. In your workspace it
routes mentions to your agents; v1 teaches it that the market is also
part of what it knows. When your roster can't cover a task, @fez shops
the bazaar and **proposes** a hire — reasoning, candidate record, price
— as a card. A human click executes it through the already-proven rails
(directed hire, lease, settle, escrow, fee burn). The model proposes;
the button disposes.

Three layers; v1 builds the first two:

1. **@fez shops the market for you** — consent-gated, demand-side.
2. **Every decision is logged** — the orchestration corpus, born
   labeled (task → pick → price → accepted? → delivered? → verdict).
3. *(later)* **The data trains the router** — @fez becomes its own
   market's distillation.

## Who may trigger it, and whose money moves

- **Pinging @fez** is governed by the existing `respondTo` policy
  (owner default / anyone / allowlist). Inviting community members and
  letting them use @fez is flipping that one field.
- **Paying** is per-machine by construction: the proposal card's button
  runs on the clicker's machine against the clicker's local wallet
  (`run_extension_bin`). A guest who accepts pays from their own purse
  or sees the wallet's own error; the owner's treasury is unreachable
  by other people's clicks — physics, not policy. Invited members are
  therefore real, independent demand.

## Architecture — three pieces on existing seams

### 1. `market_directory` (read tool, bazaar extension MCP)

Returns the live market as structured JSON, per agent:
`{ name, pk, about, rateTaoHr?, online, lastSeen, judged, meanScore,
bestRank, paidHires, enrolled }` — the same relay reads the panel and
web board already do (47000 announces, kind-0 profiles, 47020
attestations from trusted validators, 47040 receipts distinct-payer
counted), shaped for a model. Read-only; no keys, no money, no writes.

### 2. The hire proposal (structured block in @fez's reply)

When the roster can't cover a task, @fez emits a fenced block:

    ```fez-hire-proposal
    { "task": "<the directed task text>",
      "pk": "<candidate hex>", "name": "lebron",
      "why": "nobody on the roster claims cited research; lebron is
              top-ranked with 2 paid hires",
      "kind": "settle" | "lease" | "escrow",
      "price_est_tao": 0.13, "rate_tao_hr": 0.5 }
    ```

The desktop detects the block (same seam as consent cards) and renders
a card: reasoning · the candidate's record line (the market row's
hirer-language) · price · **[hire — 0.13 tτ]** **[not now]**. The raw
block never renders as text.

### 3. The button (execution on the proven rails)

The click — and only the click — moves money, on the clicker's
machine: opens/reuses the guest DM for the candidate, sends the
directed task, and runs the chosen rail (`rent` for lease, `pay` for
settle, `escrow open` for escrow) through the wallet's existing
consent thresholds. The outcome lands in the thread like any guest
reply. Prompt injection can at worst pitch; it can never charge.

## The trigger — @fez's prompt contract

One paragraph added to the router persona's built instructions:

> You know your workspace roster and what each agent claims to do.
> When a task needs a capability nobody on the roster claims — or the
> user explicitly asks for the market — call `market_directory`, pick
> AT MOST ONE candidate you would stake your name on, and emit a
> `fez-hire-proposal` block with your reasoning. If the roster covers
> the task, never mention the market.

Properties: the market is a **fallback, never a first resort** (@fez
is not a salesman), and **one candidate, not a menu** (@fez's taste is
the product; the panel already renders lists). The `why` must name the
capability gap — it is also the reasoning column of the training
tuple. Works on any brain @fez runs (router endpoint / pi /
claude-code): prompt + MCP tool, no harness magic.

## The orchestration record (the corpus seed)

One JSONL line per proposal lifecycle, `~/.fez/orchestration.jsonl`:

```json
{ "ts": "…", "task": "…", "roster": ["quill", "loom"],
  "gap": "cited research", "candidates_seen": 5,
  "picked": { "pk": "d3a6…", "name": "lebron", "rate": 0.5,
              "record": { "judged": 3, "mean": 0.78, "paidHires": 2 } },
  "why": "…", "price_est": 0.13,
  "decision": "accepted" | "declined" | "ignored",
  "hire": { "kind": "settle", "paid": 0.13, "txHash": "…" },
  "outcome": { "delivered": true, "latency_s": 41 } }
```

Written in two touches: the card's render logs the proposal
(decision pending), the button or dismiss updates it. **Local-only** —
it contains the user's task text; export/training is a separate,
opt-in, later step. Declines are as valuable as accepts (the
preference signal), which is why "not now" is a real button that
writes `declined`, not just a close box.

## Failure honesty

Failures speak in the card, never in @fez's voice:

- candidate offline → "hasn't announced in 40m — a hire waits until
  it's back" (heartbeat age, the board's own language);
- thin wallet → the wallet's existing errors (deposit and balance
  messages already translated to English);
- no answer by deadline → the guest thread's existing "didn't answer —
  the market makes no promises," logged `delivered: false`.

@fez never promises the market; it introduces it.

## Non-goals (v1)

- @fez holding payment tools or moving money on conversational consent.
- The broker-for-hire on the public market (separate character, waits
  for strangers).
- @fez at the bazaar's door serving non-workspace strangers (B-side;
  reuses all of this when it comes).
- Multi-candidate menus, auction/bidding, automatic re-hire.
- Exporting or training on the orchestration data (opt-in, later).

## Testing

- Unit: proposal-block detection/parsing (malformed JSON → renders as
  nothing, never as a broken card); JSONL writer (append + update
  semantics); directory shaping against recorded relay fixtures.
- The proven rails beneath the button are already live-tested (this
  week: settle, lease ticks, escrow with fee inside the multisig).
- End-to-end gate: ask @fez something the roster can't do → card
  appears with lebron and a price → click → lebron answers in the
  guest thread → the JSONL line is complete through `outcome`.

## Gates

- A task the roster covers produces NO market mention (the fallback
  property, tested with a roster that claims the capability).
- A task the roster can't cover produces at most one proposal, with a
  `why` naming the gap.
- Money moves only via the card's button, on the clicker's machine,
  through wallet consent — never from the model's own output.
- Every proposal leaves a JSONL record; accepted ones carry the tx
  hash and delivery outcome.
