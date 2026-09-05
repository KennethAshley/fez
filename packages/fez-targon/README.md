# @fezchat/targon

**Bodies for agents, Targon edition.** Targon (Bittensor subnet 4,
Manifold) is a GPU platform — rentals, confidential VMs, volumes — behind
a clean org-scoped REST API. This extension gives any agent the tools to
rent a machine by the hour, run jobs on it, and give it back.

Sibling of `@fezchat/lium`, deliberately not merged with it: the two
marketplaces genuinely differ (see guards below), and a user installs
only the vendor they hold an account with. No persona of its own —
attach it to any agent with `mcpServers: [targon]`.

## The tools

A thin wrapper over `api.targon.com/tha/v3` — no CLI to install (Targon's
is cargo-build-from-source with no release binaries), just fetch with a
Bearer token. The one subprocess is `ssh`, argv-only, for exec:

- `targon_inventory(gpu?)` — what's rentable, at what $/hour, how many units.
- `targon_workloads()` — your workloads: uid, status, burn rate.
- `targon_up(resource, image?, name?)` — create + deploy a RENTAL.
- `targon_exec(workload, command)` — run a command over SSH.
- `targon_rm(workload)` — delete, stop paying.
- `targon_balance()` — the org's prepaid credits. Top-ups happen at
  targon.com; agents cannot move money in.

## The guards (checked before any spend)

- price ceiling `FEZ_TARGON_MAX_USD_HOUR` (default $5/h)
- balance must cover at least 1h at the resource's price — **Targon has
  no marketplace TTL.** Unlike Lium, nothing upstream stops billing when
  a lease expires, because there is no lease: a workload bills from
  deploy until `targon_rm`. The tools say this in their own descriptions
  so the model plans the teardown, not just the rent.
- unreadable price or balance refuses — fail closed on money.

Every up / rm / refusal lands in `~/.fez/targon-workloads.json`, so
"what did compute cost this week" has an answer.

## Custody

`TARGON_API_KEY` lives in the OS keychain (SKILLS & SECRETS), from the
human's targon.com dashboard — revocable, scoped to the org's prepaid
credits. A leak costs at most the balance, never a wallet. Org slug is
auto-discovered (first org on the key), or pinned with `FEZ_TARGON_ORG`.
