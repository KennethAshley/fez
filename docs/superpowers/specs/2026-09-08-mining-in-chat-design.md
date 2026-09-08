# Mining in Chat — Design

**Date:** 2026-09-08
**Status:** Approved design, pre-implementation
**Supersedes:** the mining nav-view catalog (`packages/fez-mining/src/gui.tsx`, from the any-subnet-mining v1 + LiumMachine specs). The CLI/harness/contract those built stay; only the GUI surface changes, plus one contract addition (config schema).

## Goal

Rework the mining UI to fit Fez's Slack-like model: a **`#mining` channel** whose contents are your active miners, **one per thread**, each managed by a card in the thread — status, logs, config, stop. Starting a miner is a picker flow that ends in a new thread. Per-subnet configuration becomes a first-class, schema-declared form instead of the manual `FEZ_MINE_FORWARD_ENV` env dance.

The engine underneath (the `fez-mine` CLI, the machine seam, LiumMachine, the sentinel) is unchanged — this is a new front end over the same commands, plus a config schema on the contract.

## Precedent

`packages/fez-git/src/gui.tsx` is the pattern to mirror: it owns `source: "fez-git"`, manages its own channels via `client.ensureChannel({source})` / `client.channelsFrom(source)`, and registers a `registerThreadView(name, match, render)` that renders a card over a matching thread. Mining does the same with `source: "mining"`.

## 1. The chat surface

- The extension owns a **`mining` channel source**. On activate it ensures a single channel: `client.ensureChannel({ name: "mining", source: "mining" })`.
- The **⛏ rail entry opens that channel** instead of the nav-view page. (The `registerNavView` catalog is removed; discovery moves into the New-miner flow, §3.)
- The channel's messages ARE your miners: **each active miner is one thread**, anchored by a root message the extension posts when the miner starts (see §2). `channelsFrom`/message listing gives the extension the set of miner threads to reconcile against state.

## 2. The miner thread

**Root message (the anchor):** posted by the extension on start, content is a stable, parseable line so `registerThreadView`'s `match(rootContent)` can claim it and recover the miner identity:

```
⛏ mining · netuid <N> · persona <P>
```

`match` returns true for any content starting with `⛏ mining ·`; the card parses N and P from `rootContent`.

**The card (`registerThreadView`, rendered above the replies)** is the management surface, driven entirely through `api.processes.run("fez-mine", …)` (same seam as today — the GUI never touches state files or the chain directly):

- **Status** — live dot, uid, machine: `local` or `pod <id> · $<rate>/hr · <ip:port>`, the `attention` warning line when the spend guard trips. Polled from `fez-mine status --json` every 10s while mounted.
- **Log tail** — last ~12 lines of the miner's log, via a new `fez-mine logs --netuid N --persona P` verb (tails `~/.fez/mining/<netuid>-<persona>/miner-child.log`).
- **Config** — the form rendered from the descriptor's schema (§4), pre-filled with the miner's current values; **Save & restart** applies changes (`fez-mine config set …` then a stop/start).
- **Stop** — `fez-mine stop …`; the thread stays (history), its root gets a "stopped" reply.

**Lifecycle as replies (timeline):** the extension posts a system reply into the thread on each lifecycle transition — started, config-changed, stopped, reprovisioned (pod churn), needs-attention, died. The thread becomes a scrollable history. These are posted by the **headless part** (it already runs the sentinel), so they fire even when the desktop is closed; the desktop just renders them.

**Reconciliation:** a miner in `~/.fez/extension-data/fez-mining.json` with no thread yet gets one (post the root message); a thread whose miner entry is gone is left as history (no delete). The extension keys threads by `(netuid, persona)` parsed from the root.

## 3. The "New miner" flow

- A **New miner** affordance in the `#mining` channel — a composer `/mine` command and/or a header button — opens the picker (a mounted flow, not the resident view):
  1. **Subnet** — the 129-subnet catalog (from `fez-mine subnets`, cached), curated-first, `hardware-gated` and `agent-run (v2)` badges as today. On-demand discovery.
  2. **Machine** — only when the descriptor declares `requirements.gpu`/`publicEndpoint`; local-disabled-with-reason / Rent GPU, as today.
  3. **Config form** — rendered from the chosen descriptor's config schema (§4); required fields gate Continue; secrets show as password inputs.
  4. **Persona** — in-view select (existing pattern).
  5. **Confirm** — the burn (+ `$/hr` + Lium balance for a lium pick, with the balance-floor block).
- On confirm: write config (`fez-mine config set`), then `fez-mine start …` (with `--machine lium` when chosen). The start path posts the root message and the thread appears.

## 4. Config schema — the contract change

`packages/fez-extension-api/src/miner.ts` gains, on `SubnetMiner`:

```ts
config?: ConfigField[];

interface ConfigField {
  key: string;                                  // env-ish identifier, unique per descriptor
  label: string;                                // human label for the form
  type: "string" | "number" | "boolean" | "select" | "secret";
  default?: string | number | boolean;
  options?: string[];                           // for type "select"
  required?: boolean;
  help?: string;                                // one-line hint under the field
}
```

And `MinerContext` gains:

```ts
config: Record<string, string | number | boolean>;  // resolved values, secrets included, in-memory only
```

**Storage & custody:**
- Non-secret values live in `MinerEntry.config` (in `fez-mining.json`), so they survive restarts and the sentinel can relaunch with them.
- **Secret** values are written to the **macOS keychain** (service `fez-mining`, account `<netuid>:<persona>:<key>`) by a new `fez-mine config` CLI verb — never in plain state, mirroring fez-wallet's custody stance (only the CLI reads/writes them; the webview shells to the verb).
- At **launch**, the runner resolves the full config — non-secrets from state, secrets from the keychain — into `ctx.config` (in-memory), and hands it to the descriptor.

**The descriptor maps config → how it runs.** bazaar's `start()` reads `ctx.config.provider` → `BAZAAR_PROVIDER`, `ctx.config.model` → `BAZAAR_MODEL`, `ctx.config.dailyCap` → its cap env, and its Nostr/provider secret keys from `ctx.config` into the machine exec env. **This replaces the manual `FEZ_MINE_FORWARD_ENV` allowlist** — the config schema now declares exactly what a miner needs, the harness resolves it, and the descriptor forwards it; the machine seam's env-refusal (loader vars) still applies.

**Descriptors declare:**
- **bazaar (553):** `provider` (select: chutes/anthropic/openai/openrouter, default chutes), `model` (string, default the profile's), `dailyCap` (number, default 8), `secretKey` (secret — the Nostr key, else keychain fallback), `providerKey` (secret — the LLM key).
- **gradients (56):** its provider/API keys as `secret` fields, plus whatever `start()` needs.

## 5. Code changes

- **Replaced:** `packages/fez-mining/src/gui.tsx` — the nav-view catalog becomes: the `#mining` channel source + the thread-view card + the New-miner picker flow. `gui-rows.ts`'s `subnetRows`/`machineChoices` are reused inside the picker.
- **Contract:** `miner.ts` — `ConfigField`, `SubnetMiner.config`, `MinerContext.config`.
- **CLI:** `fez-mine` gains `config get|set` (state + keychain) and `logs`; `start`/`run` resolve config into `ctx.config`. `MinerEntry` grows `config`.
- **Headless:** the sentinel part posts lifecycle replies into the miner's thread (via the client publish seam available to headless parts) and ensures root messages exist for state miners.
- **Descriptors:** bazaar (sibling repo) and gradients declare `config` and map it in `start()`; bazaar's remote launch stops depending on externally-set env, reading `ctx.config` instead.

## 6. Build phasing (each ships alone)

- **A — config in the contract (headless, no UI):** `ConfigField`/`config` on the contract; `fez-mine config get|set` (state + keychain) and config resolution into `ctx.config` at launch; bazaar + gradients declare their schemas and map config in `start()`. Verified by CLI: set config, start, confirm the miner runs with those values (bazaar on a pod with provider/model/keys from config, no `FEZ_MINE_FORWARD_ENV`). This alone removes the manual env dance.
- **B — the channel + thread card:** `mining` channel source, ⛏ opens it, `registerThreadView` management card (status + log tail + Stop), root-message reconciliation. Replaces the nav page.
- **C — New-miner picker + config form:** the full start flow with the schema-driven form; `fez-mine logs`.
- **D — lifecycle timeline:** headless posts started/stopped/reprovisioned/needs-attention/died replies; config Save & restart.

## 7. Deliberate exclusions (YAGNI)

- **Live log streaming to the relay** — the card polls a log tail; the miner's full output does not stream as replies. Bazaar's actual on-relay activity already shows in the Bazaar pane.
- **Non-macOS keychain** — secrets use the macOS keychain (the app is a Mac desktop today); a portable secret store is a later concern.
- **Multiple channels / per-subnet channels** — one `#mining` channel holds all miner threads.

## Risks

- **Root-message parsing** as the identity key is brittle if the format drifts — pin the format in one place (a shared `minerRootLine(netuid, persona)` / `parseMinerRoot(content)` pair), used by both the poster and the `match`/card.
- **Secret handling** — the webview must never see secret values; the form writes via `fez-mine config set --secret` (keychain) and reads back only a "set / not set" flag, never the value. Custody grep discipline like fez-wallet's.
- **Headless posting** — a headless part posting into a channel needs the publish seam and the owner key; confirm the sentinel context has it (it posts as the workspace owner, same as other headless publishers).
- **Reconciliation races** — two desktops open, or the sentinel and desktop both ensuring a root: dedupe by `(netuid, persona)`, make root-ensure idempotent.

## Testing

- **A:** `fez-mine config set/get` round-trips (non-secret in state, secret in keychain, get returns set/not-set for secrets); config resolves into `ctx.config` at launch (unit test with a fake descriptor asserting it received the values); a live bazaar-on-pod run driven purely by config, no `FEZ_MINE_FORWARD_ENV`.
- **B/C:** the pure helpers (`minerRootLine`/`parseMinerRoot`, the config-form field model, subnetRows reuse) unit-tested; the thread-view card and picker are mount-form components verified by desktop walkthrough.
- **D:** the lifecycle-reply poster is a pure function of (transition, miner) → message, unit-tested; posting is best-effort.
