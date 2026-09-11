# Metagraph enrichment — report

2026-09-08. netuid 553 (rehearsal testnet), wss://test.finney.opentensor.ai.

## Storage-item verification (live, against @polkadot/api metadata)

Connected directly (throwaway probe script, deleted after) and enumerated
`Object.keys(api.query.subtensorModule)` — 258 entries. Findings that
changed the plan from the task brief:

- `incentive(netuid)`, `emission(netuid)`, `consensus(netuid)`, `dividends(netuid)`,
  `active(netuid)`, `lastUpdate(netuid)`, `immunityPeriod(netuid)` — **all exist**,
  confirmed as `Vec<u16>`/`Vec<u64>`/`Vec<bool>` indexed by uid (or bare `u16` for
  immunityPeriod), exactly as the brief assumed.
- **`trust(netuid)` and `rank(netuid)` do NOT exist** as their own storage items on
  this runtime. Only `validatorTrust(netuid)` exists in that family — there is no
  bare "trust" or "rank" vector to read. Grepping the full 258-key list for
  `/trust|rank/i` returns only `emissionBarRank` and `validatorTrust`.
- Where `trust`/`rank` (and everything else) actually live: **`api.call.neuronInfoRuntimeApi.getNeuron(netuid, uid)`** —
  a runtime API (not pallet storage) that returns one struct per uid with
  `rank`, `emission`, `incentive`, `consensus`, `trust`, `validatorTrust`,
  `dividends`, `lastUpdate`, `active`, `coldkey`, `stake` all bundled together.
  This is the SAME struct bittensor's own metagraph tooling reads.

**Decision:** built `metagraph()` on `neuronInfoRuntimeApi.getNeuron`, not the
five separate per-uid vectors the brief sketched. One call instead of five,
gives `trust`/`rank` (which the vectors can't), and is verified live to work.
`uids(netuid, hotkey)` (existing `uidFor`) still resolves the uid first — no
`getNeuronByHotkey` exists, only by-uid lookup. `immunityPeriod(netuid)` (the
vector approach's own storage read) + `rpc.chain.getHeader()` supply the
immunity countdown, exactly per the brief's formula.

Live probe values pinned in the code comment (subtensor.ts):
uid 5 (quill), netuid 553, block 7962278 area — `incentive` sample
`[0, 24516, 15958, 14398, 10661, 0]`, `immunityPeriod` = 5000,
`getNeuron(553, 5)` returned the full struct with `trust`, `rank`,
`consensus`, `dividends`, `active`, `lastUpdate`, `coldkey`.

## Task 1 — fez-wallet `metagraph` verb

- `packages/fez-wallet/src/chains/subtensor.ts`:
  - `SubtensorApi.query.subtensorModule.immunityPeriod(netuid)`, and
    `SubtensorApi.call.neuronInfoRuntimeApi.getNeuron(netuid, uid)` added to
    the interface (narrow, same style as the rest of the file).
  - `RawNeuron` (the bits of `getNeuron().toJSON()` this file reads) and
    `MetagraphInfo` (the shaped output) types.
  - `shapeMetagraph(uid, neuron, immunityPeriod, currentBlock, stake)` —
    **pure**: u16 fields (`incentive`/`trust`/`rank`/`consensus`/`dividends`)
    normalized `/65535` → 0..1 floats; `emission` (rao/block, u64) through the
    existing `formatRao`; `immunityLeftBlocks = max(0, immunityPeriod -
    (currentBlock - lastUpdate))`, floored at 0.
  - `metagraph(api, netuid, hotkey)` — the chain-touching wrapper: `uidFor` →
    `Promise.all([getNeuron, immunityPeriod, getHeader])` → stake via the
    **existing** `stakedAlpha(api, netuid, hotkey, neuron.coldkey)` (reused,
    not reimplemented) → `shapeMetagraph`. Returns `undefined` (not an error)
    when the hotkey isn't registered on the netuid.
- `packages/fez-wallet/src/chains/substrate.ts`: added `rpc.chain.getHeader()`
  to the shared `SubstrateApi` interface (current block number, for the
  immunity math).
- `packages/fez-wallet/src/cli-commands.ts`: `metagraphInfo(netuid, hotkey)`
  (read-only, mirrors `registrationCost`) and `cmdMetagraph` (prose form).
- `packages/fez-wallet/src/cli.ts`: `fez-wallet metagraph --netuid N --hotkey
  <ss58> [--json]`, wired through the existing `--netuid`/`--hotkey` flag
  parsing (already present for `register`'s remote-hotkey override). No
  `requireRehearsalNetwork` call — this is read-only, same as `cost`.

### TDD — `shapeMetagraph` (packages/fez-wallet/tests/subtensor.test.ts)

Three cases, pure/injected, no chain:
1. u16 normalization (`24516/65535`, `65535/65535 = 1`, `0 → 0`) + `emission`
   through `formatRao` + `active`/`stake` pass-through, `stake` undefined when
   not given.
2. `stake` present → `formatRao`'d.
3. Immunity math: `5000 - (1200-1000) = 4800` while still immune; floored at
   `0` once `currentBlock - lastUpdate > immunityPeriod` (never negative).

## Task 2 — fez-mine passthrough

`packages/fez-mining/src/cli.ts`: `fez-mine metagraph --netuid N --persona P`.
Resolves the hotkey from the persona's `MinerEntry.hotkey` (state), falling
back to `fez-wallet status <persona> --netuid N --json`'s `.address` (the
persona's own derived account IS its hotkey, per the architecture note in
cli-commands.ts). Shells `fez-wallet metagraph --netuid N --hotkey <hotkey>
--json` and passes the parsed JSON straight through. **Any** failure along
this path (no entry, no hotkey, wallet-bin error, chain unreachable) is
caught and printed as `{}`, exit 0 — verified live:

```
$ fez-mine metagraph --netuid 553 --persona nonexistent-persona-xyz
fez-wallet: no wallet for "nonexistent-persona-xyz" — run: fez-wallet derive nonexistent-persona-xyz   (stderr, from the shelled fez-wallet)
{}                                                                                                      (stdout)
exit=0
```

## Task 3 — GUI display

`packages/fez-mining/src/gui.tsx`:
- Local `MetagraphInfo` type (mirrors the wallet's — copied, not imported,
  since the GUI only ever sees it as `fez-mine`'s JSON) and a shared
  `metaLine(m)` formatter: `incentive 0.37 · emission 0.055218235 · trust
  0.00 · rank 0.00[· stake 12.3][· immunity 340 blk left]`. `stake` and the
  immunity clause are omitted when absent/lapsed; the whole line is omitted
  when the read failed or the hotkey isn't registered (`uid === undefined`).
- `MiningPage`: polls `fez-mine metagraph` per active miner every 30s
  (`loadMetagraph`, its own `setInterval`, independent of the 10s status
  poll). Reads the current miner list through a `useRef` so the 30s interval
  isn't torn down and rebuilt every time the 10s status poll updates
  `miners`. Renders `metaLine(...)` as an extra `skill-desc` line under each
  active-miner row.
- `MinerCard` (the thread card): same `metaLine`, its own `loadMetagraph` +
  30s interval (separate from the existing 10s status/logs poll — a chain
  read is heavier than a local status check), rendered under the existing
  status line.
- All chain-touching work stays server-side (`fez-mine` → `fez-wallet` →
  chain); the GUI only ever parses JSON off `api.processes.run`.

## Verify

- `fez-wallet`: `npm test` — **352 passed** (24 files, incl. the 3 new
  `shapeMetagraph` cases). `npm run check` (tsc --noEmit) — clean. `npm run
  build` — clean, `dist/cli.js` etc. all emit.
- `fez-mining`: `npm test` — **82 passed** (14 files, unchanged — no test
  covers the GUI poll wiring, which is UI-only per the task's "Ken's
  walkthrough" note). `npm run check` — clean. `npm run build` — clean,
  `dist/gui.js` (36.7kb) emits.
- Live: `node packages/fez-wallet/dist/cli.js metagraph --netuid 553
  --hotkey 5H1U2PBC7ToS45GWq7EUDMAKfZgyiFdc5LingifhKPRg614s --json` →

  ```json
  {"uid":5,"incentive":0,"trust":0,"rank":0,"consensus":0,"dividends":0,"emission":"0","active":false,"stake":"0","immunityLeftBlocks":0}
  ```

  uid 5 confirms this is quill's registration. All-zero fields and
  `immunityLeftBlocks:0` are real chain state, not a bug: `lastUpdate` for
  this uid (7925697) is ~36,600 blocks behind the current tip (7962278),
  well past the 5000-block `immunityPeriod` — this registration is stale and
  currently earning nothing. Also live-checked `fez-mine metagraph` degrading
  to `{}`/exit 0 on a bad persona (above).

## A discrepancy worth flagging (not fixed, not in scope)

`getNeuron(553, 5)`'s raw `stake` field reports `248111176225` for coldkey
`5Gbk1c…` against this hotkey, but `stakeInfoRuntimeApi
.getStakeInfoForHotkeyColdkeyNetuid(hotkey, coldkey, netuid)` — the existing,
already-tested `stakedAlpha()` this code reuses (and that `personaStatus`/
`payoutPersona` already depend on for real money movements) — reports `0`
for the identical (hotkey, coldkey, netuid) triple. `metagraph()` trusts
`stakedAlpha` per the task's explicit instruction to reuse it, so quill's
metagraph shows `stake: "0"`. Whether `getNeuron`'s bundled `stake` array or
the dedicated stake-info runtime API is the "true" figure is a chain-runtime
question outside this task's scope — flagging it rather than picking one
silently.

## Concerns

- `rank` in the shipped output is the Yuma-consensus normalized rank score
  (0..1, from `getNeuron`), **not** a leaderboard ordinal ("uid 5 is rank
  #12 of N"). The task's example GUI line (`rank #12`) implied an ordinal;
  the chain doesn't hand us one directly (computing it would mean fetching
  every uid's rank and sorting client-side). Shipped as `rank 0.42` — same
  0..1 treatment as the other Yuma scores — flagging the mismatch with the
  brief's illustrative text rather than fabricating a position.
- Immunity math follows the task's literal formula (`immunityPeriod -
  (currentBlock - lastUpdate)`) using `lastUpdate` (last weight-set epoch),
  not `blockAtRegistration` (which also exists as its own storage item and
  is what "true" bittensor immunity is keyed on). For a freshly-registered,
  never-weighed uid the two coincide; for an old uid whose weights were once
  set and then went stale, `lastUpdate`-based immunity can under- or
  over-report versus registration-based immunity. Followed the brief as
  written rather than silently swapping the metric.

## Files touched

- `/Users/ken/Projects/Fez/fez/packages/fez-wallet/src/chains/subtensor.ts`
- `/Users/ken/Projects/Fez/fez/packages/fez-wallet/src/chains/substrate.ts`
- `/Users/ken/Projects/Fez/fez/packages/fez-wallet/src/cli-commands.ts`
- `/Users/ken/Projects/Fez/fez/packages/fez-wallet/src/cli.ts`
- `/Users/ken/Projects/Fez/fez/packages/fez-wallet/tests/subtensor.test.ts`
- `/Users/ken/Projects/Fez/fez/packages/fez-mining/src/cli.ts`
- `/Users/ken/Projects/Fez/fez/packages/fez-mining/src/gui.tsx`
