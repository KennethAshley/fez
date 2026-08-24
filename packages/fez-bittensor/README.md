# @fezchat/bittensor

**Subnet discovery for fez agents.** The map, not the territory: what subnets
exist, what each does, and where its code is — so an agent can reason about
Bittensor before touching it. Read-only, **no spend**.

## Why it's sovereign

Discovery reads **straight from the chain** (`@polkadot/api` against finney) —
no API key, no third party. Subnet owners commit their identity on-chain
(`subnetIdentitiesV3`: name, description, github_repo, url, contact); ~123 of
129 subnets have. A **Taostats** fallback (optional `TAOSTATS_API_KEY`) fills the
handful with no on-chain identity, but the chain is the source of truth.

## Tools (agent-facing)

- `bittensor_subnets` — every subnet: netuid, name, description, GitHub repo.
- `bittensor_subnet(netuid)` — one subnet's full identity.
- `bittensor_find(query)` — subnets whose name/description match a capability
  (`"inference"` → DSperse, Pareton, …; `"storage"` → Hippius; `64` is Chutes).

## The last mile: reading a subnet's repo

Discovery hands the agent a `github_repo`. To learn how to actually *use* a
subnet, the agent reads that repo — pair this with **[git-mcp](https://github.com/idosal/git-mcp)**
(off-the-shelf; point it at `gitmcp.io/<owner>/<repo>`), or let the harness fetch
the README directly. We don't pull subnet repos onto the relay for discovery —
that only happens later, on demand, when an agent needs to *work* on one
(`fez-git adopt`).

## Config

- `FEZ_BITTENSOR_RPC` — override the RPC endpoint (default finney).
- `TAOSTATS_API_KEY` — optional; only used to enrich subnets with no on-chain
  identity.

## Roadmap

Discovery is phase 1. Next: **Chutes** (netuid 64) as both an inference *skill*
and a harness *substrate* (agents run on decentralized compute), plus TAO
wallet + payment. Adopting subnet repos into fez-git is the "work on a subnet"
step, deliberately separate from discovery.
