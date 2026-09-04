# Agent Identity — the id is the agent, the name is a label

*2026-09-03. Prompted by a live bug: renaming an agent forked a new
identity (quill→lebron minted a fresh npub, orphaning quill's key,
wallet, stake, and record). Fix #1 (name read-only) shipped in v0.4.5 to
stop the bleeding. This is the real fix. Reference: buzz's persona.id /
displayName split.*

## Thesis

An agent's identity should be a **stable id**, and its **name a mutable
label** over that id — buzz's model (`persona.id` + `displayName`). fez
got it backwards: the name IS the id, in three places at once, so a
relabel is an identity change. The name should be free to change; the id,
never.

## What is name-keyed today (audited)

- **Persona file** `~/.fez/personas/<name>.md`.
- **Nostr key** — MINTED once (random), stored `fez-keys/agent:<name>`.
  Movable: it is not derived from the name, only filed under it.
- **Wallet** — `deriveAgentPair(root, name)` = `//<name>`. NOT movable:
  deterministic from the name, so a new name is a different account,
  address, stake, and uid.
- **@mentions / routing** resolve by name (name IS the lookup key today).
- **fez-bazaar miner** resolves its key by name (`fez-keys/agent:<name>`)
  and its hotkey/announce identity from it.

The nostr key is the natural stable id — already unique, already the
relay/bazaar/DM identity. The wallet is the one thing that must stop
deriving from the mutable label.

## The model (buzz-shaped)

Each agent gets an immutable **id**, minted at creation and never
changed. The id is the anchor everything derives from:

- persona file keyed by id (`<id>.md`), or a `id:` frontmatter field on
  the existing `<name>.md` if we keep files name-addressed for a
  transition — decided at implementation.
- nostr key at `fez-keys/agent:<id>`.
- wallet at `//<id>`.
- `name` (a.k.a. displayName) is mutable frontmatter — what shows in
  chat, DMs, the roster, and what @mentions resolve to (mention text →
  the agent whose name is that → its id).

Candidate for the id: the agent's own npub (stable, unique, already
minted). Using the npub as the derivation seed also means the wallet is
bound to the same identity the relay knows — one identity, not two.

## The migration wrinkle (the hard part, stated honestly)

Existing agents have wallets at `//<name>` holding real (testnet) stake
and registered uids. Switching derivation to `//<id>` changes their
address — orphaning stake, balance, and registration. Three options:

1. **Grandfather + go-forward.** Existing agents keep `//<name>`
   derivation (recorded as `walletSeed: <name>` in their persona);
   NEW agents derive from `//<id>`. One dual-path branch in derive,
   forever, but zero migration and zero orphaning. Laziest safe path.
2. **Migrate on rename.** When an agent is first relabeled, transfer its
   balance `//<oldname>` → `//<id>`, unstake+restake, re-register the
   uid. A real multi-tx ceremony, only paid when someone actually
   renames — but it touches money and chain state, so it needs its own
   gates.
3. **Full migrate now.** Move every agent to `//<id>` up front. Most
   coherent end state, most risk, no reason to pay it before anyone
   renames.

Recommendation: **option 1.** Record each agent's `walletSeed` explicitly
(defaulting to its current name for existing agents, to its id for new
ones); derive from that field, not from the live name. A rename then
changes only the label and the nostr-key filing (movable), never the
wallet seed — so relabel is safe, and no money ever moves. Migration to
id-seeded wallets becomes optional and per-agent, later.

## Surfaces touched

- **fez core** (`personas.ts`): parse/carry `id` + `walletSeed`; @mention
  resolution keys on name→id.
- **fez-wallet** (`derive.ts`): derive from `walletSeed`, not the persona
  name; `resolveMinerSecret`/`readAgentNostrKey` look up by id.
- **fez-bazaar miner**: resolve key + wallet by id, announce name as
  displayName (its kind-0 already carries a name field).
- **fez-desktop**: the editor's name becomes editable again — but now it
  writes `displayName`, moves the nostr-key keychain entry to follow the
  id (no-op, id doesn't change), and never touches the wallet seed.
  Rename becomes a label change, as it should be.

## Non-goals (v1 of the refactor)

Migrating existing name-seeded wallets to id-seeds (grandfathered),
changing on-chain registrations, cross-machine id portability (the id is
local until published). Multi-name aliases beyond the one displayName.

## Gates

- Create an agent, relabel it twice: its npub, wallet address, stake, and
  bazaar record are byte-identical before and after; only the shown name
  changes; @mentions follow the new name.
- An existing (name-seeded) agent keeps its exact wallet address after the
  upgrade — no orphaning, verified on chain.
- The bazaar miner for a relabeled agent binds the SAME hotkey it did
  before the relabel.

## Risk

The whole point is to never orphan a wallet again — so the migration
path is the risk surface, and option 1 exists precisely to have no
migration. Any go-forward that changes an existing derivation must be
gated by an explicit, chain-verified balance check first.
