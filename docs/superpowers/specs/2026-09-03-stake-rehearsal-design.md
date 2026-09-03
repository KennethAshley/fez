# Stake Rehearsal — design

*2026-09-03. Extends the trust upgrade's stage 6 (self-stake) with a testnet
rehearsal phase, GUI-first. Approved in conversation: test alpha is a free
rehearsal studio — the mechanics are mainnet's, the money isn't.*

## Thesis

The whole economic loop of the whitepaper becomes four buttons, zero
terminal: **create agent → send to bazaar → register → stake.** On testnet
553 the buttons move play money; on mainnet the same buttons move real
value. Building against test alpha now means the riskiest chain code ships
pre-rehearsed, and "agent emancipation economics" stops being prose.

Acceptance principle (the wallet-ceremony precedent): if a step needs a
terminal, it isn't done.

## What exists (audited)

- fez-wallet derives a per-persona **sr25519 account** (+EVM) from the
  owner-held root; keys in keychain service `fez-wallet`; substrate
  machinery already signs transfers; config carries `network` +
  `endpoints.tao` with the mainnet/testnet confusion guards.
- The ceremony seam: wallet GUI runs CLI verbs via `processes.run`
  (`init --json` / `derive --json` precedent), errors surfaced as
  sentences.
- A Bittensor **hotkey is just an sr25519 keypair** — the persona's
  existing derived account can BE its hotkey. No new key material.
- The 47041 binding already carries an optional `hotkey` tag; the miner
  reads `BAZAAR_HOTKEY` from env. The validator's phase-2 metagraph uid
  resolution (open-enrollment spec) is what turns a registered hotkey into
  paid weights for non-seed miners.
- Droplet wallet holds testnet TAO (funds registration + seeding).

## Key roles (custody stays guardian-shaped)

- **Hotkey = the persona's derived account.** Identity on chain, earns
  emissions (as alpha staked to it).
- **Registration coldkey = the treasury.** The guardian pays the
  registration burn and owns the uid — consistent with the child-wallet
  model (owner funds, owner answers for it).
- **Self-stake = the agent's own account calling `addStake` to its own
  hotkey.** The agent's earnings, staked behind the agent's name, signed
  by the agent's key.

Exact extrinsic names/signatures (`burnedRegister`, `addStake`, emission
accrual semantics) are verified against the live testnet pallet at
implementation — the SDK/docs drift and the plan must pin what the chain
actually accepts, not what docs claim.

## The verbs (fez-wallet CLI, ceremony-seam compatible)

All verbs: `--json` variants for the GUI, network from config (testnet
today; the existing mainnet-confusion guards apply — no verb here may
silently touch finney), errors as plain sentences.

1. `fez-wallet register <persona> [--netuid 553]` — treasury signs the
   registration burn naming the persona's account as hotkey. Refuses when
   already registered (idempotent adopt: report the uid). Records
   `{netuid, uid, hotkey}` in the persona's mirror entry.
2. `fez-wallet stake <persona> <amount>` — persona account signs addStake
   to its own hotkey. Balance-checked with a plain refusal ("quill has
   1.2 tTAO free; staking 5 needs funding first").
3. `fez-wallet unstake <persona> <amount>` — symmetric.
4. `fez-wallet status <persona>` — chain-read: free balance, staked,
   registered uid (or not), netuid. Pure read; the GUI's display source.

## GUI (wallet panel account rows)

Each agent account row grows, in order of state:

- Unregistered + testnet: **register on the subnet** button → ceremony →
  row shows `uid 7 · netuid 553`.
- Registered: **stake** amount field + button; staked balance shown beside
  free balance (`free 2.1 tTAO · staked 5.0 tα`), both from `status`.
- Testnet marker everywhere the numbers show: values are prefixed `t`
  (tTAO/tα) so rehearsal money never reads as real. On a future mainnet
  config the same rows drop the prefix.
- Feedback discipline (this week's standing rule): every failure is a
  sentence; anything slower than a beat shows progress; chain-unreachable
  reads "unknown, not zero."

## The binding closes the loop

When a persona has a registered hotkey in its mirror, the bazaar panel's
send flow passes `BAZAAR_HOTKEY=<ss58>` in the spawn env. The miner's
existing announce path then publishes the binding WITH the hotkey tag —
and once the validator's metagraph resolution lands (open-enrollment
phase 2), quill's weights pay its own uid. Until then: registered and
staked is visible and real on chain, payment still seed-only, ledgered
honestly as before.

## Funding (one-time ops, not product)

Seed Ken's treasury with testnet TAO from the droplet wallet (manual
transfer, done by us). Agent gas rides the existing `fund <persona>`
verb. No faucet UI — testnet acquisition is an operator concern until
mainnet makes it a real on-ramp.

## Testnet wipe caveat

Bittensor's testnet is periodically reset. Chain state here is rehearsal
state: balances and uids may vanish; the GUI must render post-wipe truth
honestly (chain says unregistered → row offers register again; never
cache-say "staked 5" when the chain says nothing). The reputation record
(relay-side) is untouched by wipes — one more proof the record and the
money are separate layers.

## Non-goals (v1)

Slashing, lockups, the age ramp (rides metagraph resolution per the
open-enrollment spec), delegate/validator choice for stake, mainnet
enablement (gated on the roadmap's mainnet criteria), stake display on
the desktop AgentProfile (phase 2 — wallet panel first, one surface done
well).

## Gates

- From the GUI only, no terminal: register quill on 553, stake test
  alpha to its name, see `uid · free · staked` on its row.
- Binding published with the hotkey tag after a GUI send.
- A wiped/unreachable chain renders as unknown/unregistered, never as a
  stale claim.
- Every verb refuses mainnet under testnet config and vice versa (the
  existing network guards, exercised by tests).

## Risks

- Pallet/API drift (bittensor extrinsic shapes) — pinned at
  implementation against the live testnet, with the sidecar's
  bittensor-version note as prior art.
- Hotkey==derived-account and treasury-as-coldkey semantics need one live
  verification round before the plan hardens (emissions accrual target
  especially).
- Registration cost on testnet can move; the verb reports the burn before
  signing (consent, not surprise).
