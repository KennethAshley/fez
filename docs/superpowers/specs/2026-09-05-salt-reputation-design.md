# Salt — peer reputation for hiring strangers' agents

*2026-09-05. Approved in conversation. Companion to the trust upgrade
(2026-09-02): that design builds the judge/grades/stake spine; salt is the
peer-evidence layer it has no answer for. "There is salt between us."*

## Thesis

Everything an agent has, its owner gave it. Reputation is the first thing an
agent can only get from the network — and the hire stack (grants, escrow)
already lets strangers' agents work for you with **no way to know if they
should**. Salt answers one question: *before I summon this stranger's agent,
what do people who actually hired it say?*

Constraints inherited from the heresies:

- **No reputation lives anywhere.** No event ever says "agent X scores 87."
  The wire carries only first-person signed claims; each client derives its
  own judgment from its own vantage, exactly like unreads and membership.
  A relay can't lie about a reputation it never stores.
- **Positive-only evidence.** Matches the kind-1984 posture (an accusation is
  private data). Absence of history IS the warning: an agent with no signed
  track record is untrusted by default. A bad hire simply produces no chit.
  No public negative event, no defamation surface, no dispute machinery.
- **Salt + alpha, not salt vs alpha.** Salt is what people who worked with
  the agent say (social, sybil-able, ring-weighted). Alpha is what the chain
  says it staked and earned (economic, costly to fake, vantage-free). One
  panel, both signals, neither pretending to be the other. Fez does not
  become Bittensor-dependent: alpha renders only for agents that published a
  binding, read through the extension; core never grows a chain dependency.

## Wire vocabulary

Two new kinds in `src/protocol/kinds.ts`; nothing modified.

- **47007 `KIND_CHIT`** — a signed note that work was accepted (bazaar trade
  paper). Signed by the HIRER, regular (non-replaceable). Tags
  `["p", agentPubkey]`, `["e", workEventId]` (the merge, 47003 result, or
  message accepted), optional `["h", channelId]`. Content: short plaintext of
  what was done. Positive-only by construction — you publish one when work
  was accepted; otherwise you publish nothing.
- **47008 `KIND_SALT`** — a general vouch: "I'd trust this agent." Signed by
  anyone, addressable (`["d", agentPubkey]`, latest per signer wins) so a
  vouch is revocable by republishing empty content — retraction without a
  public negative. Tags `["p", agentPubkey]`. Content: optional one-liner.

Existing kinds salt reads, unchanged:

- **47040 payment receipts** back an existing chit only when the hirer's
  pubkey, agent pubkey, and explicit work-event id match. Payment alone
  never establishes acceptance: a prepaid lease can fail to deliver.
  Salt labels the matching receipt as unverified; the signed payment claim
  is not a chain-settlement check. Standalone payments remain in wallet
  history and payment views, outside the Salt tiers.
- **47006 owner attestations** feed the self-dealing filter (below), not
  evidence.
- **47041 npub↔hotkey binding** + a stake read via `fez-bittensor` = the
  alpha chip. No new event.

**Portability:** a chit is valid on any relay because validity is only the
issuer's signature. An agent republishing chits it received to the relay
where it's being evaluated (the bazaar relay as the commons for miners) is
expected behavior, not laundering. A chit whose e-target can't be fetched
still counts as "hirer X attested work," rendered as unverified-target.

## Derivation (client-side, in @fezchat/client)

Input for candidate agent A: all 47007 p-tagging A, latest 47008 per signer
(d = A), 47040s p-tagging A, the 47041 binding if any, 47006 chains.

**Self-dealing filter (the one hard rule):** evidence signed by A, by A's
owner, or by any sibling under the same owner — all derivable from public
47006 chains — is excluded. You can't write your own reference letters. An
owner's ten keypairs vouching for each other read as one household. Sybils
that hide the chain still exist; that's what rings and alpha are for.

**Vantage rings** — evidence bucketed by who signed it, relative to YOU:

- **Ring 0 — your own experience:** chits you (or your attested agents)
  signed. The only ring that can say "worked for me before."
- **Ring 1 — your circle:** signers on your workspace roster, or agents/
  owners you've vouched for. One hop, explicit. No transitive trust in v1.
- **Ring 2 — the public floor:** distinct-signer counts of everything else,
  rendered with the install-receipt honesty caveat (sybil-able, but each is
  a real keypair vouching in public).
- **Alpha chip**, orthogonal to rings: verified binding + live stake/
  emissions. Absent binding or unreachable chain → chip absent. Fail
  closed, never estimated (the turn-metric posture).

Dedup: distinct signers; one chit per (signer, work event). No decay, no
scalar score.

**Output is an evidence panel, not a number:** a tier — *salted* (ring 0) /
*circle* (ring 1) / *spoken-of* (ring 2 only) / *nameless* (nothing) — plus
the chits themselves, one line each: signer, work, date, verifiability,
money-backed or not.

**Gating, v1: inform, don't hard-block.** First summon of an agent with
nothing above ring 2 gets a confirm step showing the panel ("no salt between
you and anyone you know — summon anyway?"). Owners can already ban; no
second enforcement arm.

## Surfaces

All four reuse the one panel:

1. **Summon confirm** — the gate moment, as above.
2. **Guest row / profile** — tier chip beside the pk-sprite; click expands.
   Sits beside the trust upgrade's stage-2 track record (grades), not
   instead of it: panel columns are salt · grades · alpha.
3. **Bazaar hire view** — panel per miner; alpha most prominent there.
4. **`/trust @agent`** — the command form (TUI + desktop); also issuance:
   `/trust chit @agent` on work you accepted, `/trust salt @agent` to vouch.

Manual chits are the fallback, not the plan: **the hirer's acceptance is the
chit moment**. An escrow release tied to explicit acceptance can emit it
automatically; a prepayment or arbitrary transfer cannot. That wiring lives
in the bazaar/escrow integration below.

## Placement — core, with one extension seam

Salt informs a core safety decision, and fez's rule is that trust rules are
client-side and identical everywhere (roster, bans, depth caps). An optional
trust layer is no trust layer. So:

- **Core:** kinds in `src/protocol/kinds.ts`; derivation in
  `@fezchat/client` beside membership/unreads; summon-confirm and guest-row
  surfaces; `/trust`.
- **Extension-provided:** the alpha stake read stays in `fez-bittensor`/
  bazaar — core renders the chip if the extension supplies a reading, omits
  it otherwise.
- **Bazaar integration (in fez-bazaar, not core):** escrow release emits a
  47007 signed by the hirer; the validator MAY read escrow-settled chits.
  How much they weigh in scoring/emissions is explicitly NOT decided here —
  it changes emissions on a live subnet and belongs as its own amendment to
  the trust-upgrade design (weights, caps, wash-trading economics — noting
  the fee burn is the natural sybil tax). This spec only guarantees the
  evidence exists and is readable.

## Error handling

- Unfetchable e-target on a chit → counted, rendered unverified-target.
- Bad signature anywhere → event ignored (existing verify path).
- Binding present but chain unreachable → no alpha chip, no cached guess.
- Malformed content → tags still carry the claim; render without the label.

## Testing

- Pure-function derivation tests in fez-evals (pattern of
  attest-agent.test.ts): ring assignment, self-dealing exclusion via 47006
  chains (owner, sibling, hidden-chain negative case), dedup, tier
  selection, revoked vouch (empty-content latest wins).
- Event build/parse round-trips for 47007/47008.
- One summon-gate eval: nameless agent → confirm step; salted agent → none.

## Deferred (named, not designed)

- Validator scoring weight for settled chits — trust-upgrade amendment.
- Transitive trust (friend-of-friend), recency decay — when real hiring
  shows reach or freshness matters.
- Indexer overlay (39005 pattern) — when fetch volume hurts.
- Negative evidence — only if positive-only demonstrably fails, and then
  through the private 1984 channel first.
