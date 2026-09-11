# Testnet mining qualification: Desearch

**Verdict: FAIL — Desearch testnet SN41 is not qualified as an active external mining/evaluation target for Fez on the evidence available. No new qualified subnet is recommended by this report.**

Research date: 2026-09-10 America/New_York. Live observations occurred at approximately 2026-09-11 00:07–00:08 UTC. Scope is Desearch only; the parent is independently checking other candidates. Numinous was not researched. No credentials were read or supplied, no wallet was opened, no miner/validator was started, and no registration, transaction, paid search, or inference request was made. Only public source, public telemetry, and unsigned chain reads were used.

## Qualification gate

| Requirement | Result | Evidence / limit |
|---|---|---|
| Current official testnet ID | PASS | Both official role guides identify mainnet **22**, testnet **41**. “SN41 Desearch” is correct only with the test network specified. |
| Registration path and current availability | PASS, with documentation caveat | Official registration syntax can be combined with the role guides' testnet mapping. Live SN41 exists and registration is enabled; registration itself was not attempted. |
| Implemented evaluation mechanism | PASS as source evidence only | Validator runtime dispatches search queries, scores answers and submits weights; this does not establish a running testnet service. |
| Live public evidence of active testnet evaluation | **FAIL** | Chain snapshot has zero active UIDs and zero incentive/dividend entries. Public testnet W&B runs found are old and crashed. No current SN41 scoring run or reachable, officially identified SN41 evaluation dashboard was established. |
| A Fez miner evaluated by external validators | NOT TESTED | No miner was registered or run. Neither registration, chain activity, configured telemetry nor source code proves this outcome. |

## Official identity and reproducible source pin

Fetched the current default branch of [Desearch-ai/subnet-22](https://github.com/Desearch-ai/subnet-22) and resolved it to commit **`bea9712f58a5fc01c57ec441ce279499529d8bf6`**, package version `0.0.227`. The [miner guide](https://github.com/Desearch-ai/subnet-22/blob/bea9712f58a5fc01c57ec441ce279499529d8bf6/docs/running_a_miner.md) and [validator guide](https://github.com/Desearch-ai/subnet-22/blob/bea9712f58a5fc01c57ec441ce279499529d8bf6/docs/running_a_validator.md) independently specify **41 for testnet** and **22 for finney/mainnet**. The official [product introduction](https://desearch.ai/docs/guide) also identifies the production service with subnet 22.

The repository's [testnet tutorial](https://github.com/Desearch-ai/subnet-22/blob/bea9712f58a5fc01c57ec441ce279499529d8bf6/docs/running_on_testnet.md) is not a reliable current SN41 joining walkthrough: it describes creating a new subnet, uses example netuid 1, old command forms and 2023 output, and even shows a finney confirmation inside the testnet flow. Do not create another subnet or follow those example network confirmations to join SN41.

## Registration and miner operation — documented, not executed

The current [mainnet operations guide](https://github.com/Desearch-ai/subnet-22/blob/bea9712f58a5fc01c57ec441ce279499529d8bf6/docs/running_on_mainnet.md) supplies `btcli subnet register` syntax. Combining that syntax with the official testnet mapping gives the following **derived testnet command**, not a verbatim command claimed to be present in the SN41 guide:

```sh
btcli subnet register \
  --netuid 41 \
  --wallet.name <TESTNET_WALLET> \
  --wallet.hotkey <TESTNET_HOTKEY> \
  --subtensor.network test
```

This would be a state-changing registration that can consume test TAO and fees; it was not run. Use a testnet-only identity, verify installed CLI flags, and inspect the network/fee confirmation. Current funding/faucet availability and successful admission of a new hotkey were not verified. The old tutorial's subnet-creation cost is unrelated to this miner registration.

The official miner runbook uses Python 3.10+, PM2, `neurons/miners/miner.py`, a registered hotkey, an axon port and a concurrency manifest. Its documented CLI flags support the corresponding launch configuration:

```sh
python neurons/miners/miner.py \
  --wallet.name <TESTNET_WALLET> \
  --wallet.hotkey <TESTNET_HOTKEY> \
  --subtensor.network test --netuid 41 --axon.port 14000
```

The [environment reference](https://github.com/Desearch-ai/subnet-22/blob/bea9712f58a5fc01c57ec441ce279499529d8bf6/docs/env_variables.md) lists OpenAI, Apify and ScrapingDog credentials for the reference miner; Twitter bearer access is optional. Testnet does not make these upstream services free. No credentials or funded accounts were used during this research.

One documentation/source discrepancy matters: the miner guide describes general stake/permit gating, but the inspected [`base_blacklist`](https://github.com/Desearch-ai/subnet-22/blob/bea9712f58a5fc01c57ec441ce279499529d8bf6/neurons/miners/miner.py#L173) applies its numeric stake thresholds only when `subtensor.network == "finney"`. Its testnet path still checks registration, blacklist and rate limits. Do not present mainnet stake thresholds as a verified SN41 onboarding requirement.

## Live public chain evidence

Queried **`wss://test.finney.opentensor.ai`** directly using the installed Polkadot client. Calls were unsigned and did not use Fez wallet configuration. Read state at a finalized block, rather than mixing storage values from moving heads. For independent inspection, use [Polkadot Apps with the testnet endpoint selected](https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Ftest.finney.opentensor.ai#/chainstate).

First snapshot, observed `2026-09-11T00:07:28.660Z`:

- Finalized block: **7,978,581**.
- Block hash: **`0xaa306f278559b587c701cd82d7cfe2d44992c95b11fff438581097311580b2b0`**.
- `subtensorModule.networksAdded(41)`: `true`.
- `subnetworkN(41)`: **130** registered UIDs.
- `networkRegistrationAllowed(41)`: **true**.
- `burn(41)`: **500,000 rao = 0.0005 test TAO**, excluding transaction fees; a snapshot, not a future quote.
- `tempo(41)`: **99**.

Follow-up snapshot, observed `2026-09-11T00:08:16.226Z`:

| Public storage observation | Value |
|---|---|
| Finalized block | **7,978,585** |
| Hash | `0x4eadb34c981de82e3796e0132694d4e29907093422e35b8838e6b317e8071b36` |
| Block timestamp | `2026-09-11T00:07:48Z` |
| `active(41)` true entries | **0** |
| `validatorPermit(41)` true entries | **64** |
| Positive `incentive(41)` entries | **0** |
| Positive `dividends(41)` entries | **0** |
| Greatest `lastUpdate(41)` among permit-bearing UIDs | UID **107**, block **7,429,039** |
| Age of that block | **549,546 blocks**; timestamp `2026-06-26T12:46:24Z`, approximately **76.47 days** before the observed head |
| Stored nonempty `weights` rows | **9**, at UIDs `0, 1, 3, 32, 44, 49, 53, 56, 63` |

Historical timestamp was read from the timestamp extrinsic in block 7,429,039. The maximum `lastUpdate` across *all* UIDs was 7,897,549; that UID did not hold a validator permit in the snapshot. `lastUpdate` is not an evaluation receipt and can reflect registration/other chain behavior. Stored weights and nonzero emission values can outlive useful evaluation activity; neither is accepted here as proof of a current scoring service. Conversely, a zero-active chain snapshot does not prove no off-chain process exists anywhere. These observations fail the positive-evidence gate rather than establish universal absence.

Reproduction calls: `chain_getFinalizedHead`, `chain_getHeader`, `api.at(finalizedHash)`, then `query.subtensorModule.{networksAdded,subnetworkN,networkRegistrationAllowed,burn,tempo,active,validatorPermit,lastUpdate,incentive,dividends}(41)` and `query.subtensorModule.weights.entries(41)`. Read historical block 7,429,039 with `chain_getBlockHash` and `chain_getBlock`. This is a read-only procedure; no extrinsic submission is needed.

## Public evaluation telemetry

The pinned [runtime constants](https://github.com/Desearch-ai/subnet-22/blob/bea9712f58a5fc01c57ec441ce279499529d8bf6/desearch/__init__.py) select W&B entity `smart-scrape` and project `smart-scrape-1.0`. The [logging implementation](https://github.com/Desearch-ai/subnet-22/blob/bea9712f58a5fc01c57ec441ce279499529d8bf6/neurons/validators/scoring/weights.py) records validator configuration and a signed run identifier. This identifies where to look, not whether a validator is presently evaluating.

Read the public [project](https://wandb.ai/smart-scrape/smart-scrape-1.0) through **`https://api.wandb.ai/graphql`**, without authentication. Selected only run identifiers, display names, state, update/heartbeat timestamps and `config(keys:["netuid"])`; no full configuration, credentials or private logs were requested. Query used `runs(first:5, order:"-heartbeatAt", filters:"{\"config.netuid\":41}")`.

All five returned runs were named `validator-0-0.0.175`, had numeric netuid 41, and were marked **crashed**. The newest was [run ahoqmtkz](https://wandb.ai/smart-scrape/smart-scrape-1.0/runs/ahoqmtkz), with both update and heartbeat at **2025-03-21T09:19:07Z**. The next four were `igmc8sce`, `8b09pfp6`, `szt17sjd`, `900hb2v7`, also March 21, 2025. This query does not cover private projects, disabled logging or differently structured configuration. Run signatures were not verified, so even fresh telemetry would require identity corroboration before qualification.

The [official API reference](https://github.com/Desearch-ai/subnet-22/blob/bea9712f58a5fc01c57ec441ce279499529d8bf6/docs/api.md) documents unauthenticated `GET /public/miners` and `/public/miners/{hotkey}`, including validator identity and 72-hour scoring windows. However, it supplies only localhost examples, not a verified public SN41 deployment URL. No speculative port scanning or protected search requests were made. Desearch's commercial console or a production search response would not establish SN41 evaluation activity.

## What this means for the Fez demonstration

Desearch remains a plausible *development* integration: an agent could configure the real search axon, implement retrieval/synthesis improvements, version its source, tune per-search concurrency, and compare response quality/latency against reproducible local checks. That demonstrates miner engineering; it must not be labeled externally validated testnet mining. The external API consumer path also must not be confused with supplying search work as a miner.

Do not start a new Desearch adapter or register a demonstration miner on the assumption that SN41 will evaluate it. Reopen qualification only when there is an officially attributable, recent **testnet-41** validator endpoint or telemetry showing actual query/scoring windows, corroborated with chain identity/activity. Then a separately authorized miner trial must capture its own hotkey, source version, validator identity, task/result timestamps and score receipts. Recent validator chain activity alone still does not prove the Fez miner was evaluated.

**Decision for the parent: no newly qualified Desearch target. Preserve the failure explicitly and use the independently qualified fallback, if one exists; this report makes no claim about other candidates.**
