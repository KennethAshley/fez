# Any-Subnet Mining — Design

**Date:** 2026-09-07
**Status:** Approved design, pre-implementation

## Goal

A GUI in fez-desktop where a user can mine on any Bittensor subnet: pick a
subnet, pick a machine, confirm the registration burn, watch it run. Fez
provides what is common to every subnet (wallet, registration, process
supervision, status); per-subnet mining logic lives in the subnet's own
extension where one exists, or in an agent-generated plan where one doesn't.

## Shape

Subnet extensions already exist on the **consume** side (fez-hippius,
fez-chutes, fez-targon, fez-lium, fez-desearch). Mining is the **produce**
side of the same subnet, so it lives in the same extension: a new `miner`
part in the fez manifest. Coverage for the other ~120 subnets comes from an
agent fallback that fulfills the same contract.

## 1. The miner contract (fez-extension-api)

New `parts.miner` alongside `skill`/`headless`/`gui`/`relay`/`workspace`:

```ts
parts: {
  miner?: string;  // → module exporting SubnetMiner descriptors
}
```

A miner module exports one descriptor per netuid:

```ts
interface SubnetMiner {
  netuid: number;
  requirements: {
    gpu?: string;        // e.g. "A100-40GB" — absent means CPU is fine
    ramGb?: number;
    diskGb?: number;
    alwaysOn?: boolean;  // needs uptime a laptop can't promise
  };
  install(machine: Machine): Promise<void>;
  register(wallet: Wallet, netuid: number): Promise<void>;
  start(machine: Machine): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<MinerStatus>;
}
```

Five verbs plus a requirements block. Nothing else — no lifecycle hooks, no
config schema, no plugin registry. If a subnet needs more, its extension
handles it inside the verbs.

The existing bazaar (netuid 553) loop is refactored into `parts.miner` on a
fez extension. It is the reference implementation and the conformance test:
if the harness can run the bazaar miner through the contract, the contract
works.

## 2. Core harness

### Machine abstraction

```ts
type Machine = LocalMachine | LiumMachine;
```

- **LocalMachine** — spawns the miner as a supervised process; the sentinel
  keeps it alive (exactly what keeps quill running today).
- **LiumMachine** — provisions a GPU pod via fez-lium, execs over its
  API/SSH, polls status remotely. (v3 — see build order.)

### Wallets

- **Amended 2026-09-07 (was: adopt btcli wallets).** Reuse fez-wallet's
  guardian custody, which already implements the chain half
  (`chains/subtensor.ts`: `burnedRegister`, `addStake`, `uids`, live burn
  query — pinned against testnet): master mnemonic in the macOS keychain,
  each miner's hotkey is a per-persona derived sr25519 account, the treasury
  coldkey pays the registration burn and owns the uid. Registration goes
  through `fez-wallet register <persona> --netuid N` (idempotent adopt).
  btcli wallet import is deferred until users ask for it.
- Every burn or transfer requires an explicit GUI confirmation showing the
  live cost at confirm time.
- Remote machines receive **only the hotkey**. The coldkey (treasury) never
  leaves the user's Mac.

### State

Running miners tracked in `~/.fez/miners.json`:

```json
{ "netuid": 553, "machine": "local", "hotkey": "...", "source": "curated|plan",
  "status": "running", "pid": 12345 }
```

Both the GUI and the sentinel read this file. Sentinel restarts dead local
miners; the GUI polls remote ones.

## 3. Agent fallback (uncovered subnets)

For a subnet with no curated `parts.miner`:

1. Agent takes the subnet's `github_repo` from fez-bittensor discovery
   (`subnetIdentitiesV3` — ~123/129 subnets have one on-chain).
2. Agent reads the repo and emits a **mining plan**: a JSON artifact with
   hardware requirements, install steps, run command, and a pinned commit
   hash of the subnet repo.
3. User reviews the plan and the burn cost, then approves.
4. Agent executes the plan on the chosen machine.
5. The saved plan fulfills the same five-verb contract from then on —
   restarts replay the plan; no agent involved.

Plans pin a commit hash so subnet repo churn can't silently change what
runs. Re-planning (new commit) is an explicit user action.

GUI badges each subnet `curated` (extension-backed) or `agent-run`
(plan-backed).

## 4. GUI (fez-desktop)

A Mining page:

- **Subnet list** — from fez-bittensor discovery, enriched with emission and
  live registration cost from chain. Badge: curated / agent-run.
- **Flow** — pick subnet → pick machine (this Mac / rent GPU) → confirm burn
  → miner row appears.
- **Miner rows** — status, incentive, trust, emission, immunity-period
  countdown, logs. Reuses the agents-pane / connection-row patterns already
  in fez-desktop.

## Build order

Each version ships alone:

- **v1** — contract in fez-extension-api, LocalMachine + sentinel
  supervision, bazaar miner as reference implementation, GUI subnet list +
  local mining flow.
- **v2** — agent fallback (plan generation, review, replay).
- **v3** — LiumMachine provisioning (rent a GPU from inside the flow).

## Risks

- **Deregistration** — miners below the cutoff get deregistered after
  immunity. GUI shows the immunity countdown and current rank so the user
  sees it coming.
- **Burn volatility** — registration cost moves per subnet. Always show the
  live cost at confirmation, never a cached one.
- **Subnet repo churn** — agent-run plans pin a commit hash; failures
  surface as a "re-plan" action, not a silent retry against a moved repo.
- **Key safety** — coldkey never leaves the Mac; only hotkeys deploy to
  remote machines; every spend confirmed in the GUI.

## Testing

- Contract conformance: the bazaar miner run end-to-end through the harness
  (install → register on testnet → start → status → stop).
- Wallet: unit tests against a fixture `~/.bittensor/wallets` tree; no
  mainnet spend in tests.
- Plan replay: a recorded plan for one simple subnet replayed on a clean
  machine.
