# LiumMachine — Remote Mining Design

**Date:** 2026-09-07
**Status:** Approved design, pre-implementation
**Builds on:** `2026-09-07-any-subnet-mining-design.md` (v1, merged 33d1ac7) — this is that spec's v3 pulled forward, minus nothing.

## Goal

The Mining page can run a miner on a machine that isn't the user's Mac —
first target: a Lium (SN51) GPU pod, rented with TAO, mining Gradients
(SN56). One click: pick subnet → pick machine → confirm burn + $/hr → live
row. The composition story is the point: the GPU comes from a subnet, the
emissions come from a subnet, everything settles in TAO.

## 1. The machine seam (contract v2)

`MinerContext` gains `machine`:

```ts
interface MinerMachine {
  kind: "local" | "lium";        // "ssh" is the designed-for third member — see §7
  /** Run a command on the machine; one-shot, returns when it exits. */
  exec(cmd: string, opts?: { env?: Record<string, string>; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Copy a local file/dir to the machine. */
  copy(localPath: string, remotePath: string): Promise<void>;
  /** Public endpoint mappings for serving miners (axons). Empty on local. */
  ports: { externalIp: string; externalPort: number; internalPort: number }[];
}
```

- Descriptors call `ctx.machine.exec(...)` instead of spawning directly.
  One descriptor works on any machine kind whose requirements it fits.
- **LocalMachine** wraps the shell (child_process); `ports` empty.
- **LiumMachine** wraps fez-lium's CLI: `lium exec`, `lium scp`,
  `lium describe` (port map + host IP).
- `start(ctx)` KEEPS its v1 blocking contract. A remote descriptor
  launches the miner detached inside the machine (nohup + pidfile in the
  remote workDir) and then polls liveness until it dies. So
  `fez-mine-run` on the Mac remains the single supervisor shape for both
  kinds.
- **Runner reattach (new):** state carries the machine identity (§2); a
  respawned runner whose pod and remote pid are still alive reattaches
  (resumes polling) instead of re-provisioning.
- The bazaar descriptor migrates onto the seam (local-only, no behavior
  change) — it is the seam's conformance case.

## 2. Pod lifecycle: pod per running miner

- **Provision at Mine-click:** `lium up --ports 2` (1 SSH + 1 axon) with
  the docker template the descriptor's requirements name; wait ready;
  read the port map.
- **Then:** deploy hotkey (§3) → `install()` → `register?()` → `start()`.
- **Teardown at Stop:** `lium rm` — pod death wipes the hotkey and all
  ephemeral state with it. No long-lived shared pods in this phase.
- `MinerEntry` grows:

```ts
machine?: { kind: "lium"; podId: string; externalIp: string; externalPort: number; hourlyRate?: string }
```

(absent = local, backward compatible with v1 state).

- Lium disk is ephemeral; nothing a Gradients miner needs survives a pod
  anyway. Volumes are out of scope until a descriptor needs one.

## 3. Keys: hotkey to the pod, coldkey never

- New guarded fez-wallet verb: `fez-wallet export-hotkey <persona> --json`
  — emits ONLY the derived persona account's keypair (the hotkey), never
  the treasury mnemonic or any coldkey material. Same custody invariant
  style as the existing root-mnemonic rules: the export path must be
  unreachable from the MCP server's import graph.
- The harness `machine.copy`s it into the pod's bittensor wallet layout
  (`~/.bittensor/wallets/<wallet>/hotkeys/<persona>`), because subnet
  miner code loads hotkey files directly.
- Chain registration (the burn) still signs on the Mac via
  `fez-wallet register`. A compromised pod exposes one rotatable hotkey
  with no funds custody.

### Mainnet unlock (decision carried to review)

Gradients is mainnet-only; fez-wallet's `requireRehearsalNetwork` guard
blocks mainnet registration today — correctly, for v1. This spec adds a
deliberate unlock: a `fez-wallet` network switch to mainnet that requires
an explicit, separately-confirmed step (CLI flag + GUI double-confirm
naming the real-TAO consequence). Whether the unlock ships in phase C or
waits is Ken's call at spec review; everything else in this spec is
testable without it (LiumMachine phases A–B run against testnet 553
through the seam).

## 4. Sentinel + cost guards

Reconcile learns two remote failure classes:

- **Runner dead, pod alive** → respawn runner; it reattaches (cheap, no
  spend).
- **Pod gone** (Lium executor churn is expected — no SLA) →
  re-provision, re-deploy hotkey, re-install, restart, and let the miner
  re-announce its new axon endpoint.

**Spend guard:** at most N automatic re-provisions per miner per day
(default 3). Past that, the miner row enters `needs-attention` — visible
in the GUI, no silent rent burn. Every provision appends a line to the
miner's log with the pod id and hourly rate.

GUI confirm at Mine-time shows: registration burn (live), pod $/hr, and
current Lium balance (`lium_balance`). Insufficient balance blocks with a
topup pointer instead of failing mid-provision.

## 5. First target: Gradients (SN56)

New minimal package `packages/fez-gradients` (`type: extension`,
`parts.miner` only): the SN56 descriptor — clone their repo pinned to a
commit, install deps, run the miner under the seam with the axon
advertising `ctx.machine.ports[0]`. Requirements:
`{ gpu: "24GB", alwaysOn: true }`. Exact env/args pinned by reading the
Gradients repo at implementation time (same discipline as the bazaar
descriptor's Step-1 env audit).

## 6. GUI

- Descriptors with `requirements.gpu` get a **machine picker** in the
  Mine flow: "This Mac" (greyed out, with the reason) / "Rent GPU
  (Lium)". Local-only descriptors skip the picker (v1 flow unchanged).
- Miner rows for remote miners show pod id, $/hr, and endpoint.
- **Honesty badge:** subnets known to be attestation/datacenter-gated
  (Targon SN4 class) render `hardware-gated` instead of implying
  mineability. v2 ships this as a small static list in fez-mining;
  a descriptor-declared flag can replace it later.

## 7. Designed-for, not built (scoping to other mining patterns)

- **SshMachine** (`kind: "ssh"`): any user-owned host (doctl droplet,
  storage server) — no provisioning step, same exec/copy/ports verbs.
  This is the path for storage-class miners (Hippius: its Ansible flow
  runs over `exec`), where GPU pods are the wrong machine shape.
- **Requirements → machine matching:** the picker offers only machine
  kinds satisfying the descriptor's requirements block; `diskGb` exists
  today, `bandwidthMbps` added when a descriptor first needs it.
- The five contract verbs are pattern-complete: serving axons,
  job-runners (Gradients), and submit-and-wait competitions all express
  as `start()` variants. What no seam rescues is attestation-gated
  silicon — that stays a badge, not a Machine.

## Build order

- **A** — seam + LocalMachine refactor; bazaar descriptor migrates; no
  behavior change (conformance: v1 smoke still passes).
- **B** — LiumMachine + `export-hotkey` + runner reattach + sentinel
  remote reconcile + spend guard. Testable against testnet 553 run
  remotely (bazaar on a cheap pod) before any mainnet decision.
- **C** — Gradients descriptor + GUI machine picker + hardware-gated
  badge + the mainnet unlock decision.

Each phase ships alone.

## Risks

- **Lium churn** — pods vanish without SLA; mitigated by reattach +
  bounded re-provision + needs-attention state.
- **Endpoint instability** — external ip:port changes on re-provision;
  miners must re-announce (descriptor's start passes the current
  mapping every launch; nothing caches endpoints).
- **Runaway rent** — spend guard (§4); teardown on Stop is
  unconditional.
- **Hotkey on rented hardware** — accepted, scoped (rotatable, no
  funds); wiped with the pod.
- **Gradients repo drift** — descriptor pins a commit; re-pin is an
  explicit action (same rule as v1 plans).

## Testing

- Seam conformance: v1 heartbeat fixture runs through LocalMachine
  unchanged; a FakeMachine (scripted exec/copy) unit-tests the runner's
  remote path, reattach, and spend guard without renting anything.
- One real end-to-end in phase B: bazaar miner on a cheap Lium pod
  against testnet 553 — proving provision → hotkey → install → axon
  reachability → stop/teardown with real money measured in cents.
