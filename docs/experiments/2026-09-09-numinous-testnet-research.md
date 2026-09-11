# Numinous testnet availability — 2026-09-09

**Result:** Drift registered on **testnet SN155, UID76**, and the official staging API accepted its **SIGNAL** baseline agent. A separate authenticated read confirmed the saved version, **pending activation**, with no linked services. Validator execution, scoring, and rewards remain unverified. The public live-events feed was empty during the initial probe.

Sources: official Numinous repository and live API, plus OpenRouter documentation. Repository pinned to [880fa75c3627a5b5560e0ee27628489d74aa5bb2](https://github.com/numinouslabs/numinous/commit/880fa75c3627a5b5560e0ee27628489d74aa5bb2), committed 2026-08-28; release 3.1.2. Initial probes ran 2026-09-10 03:33:45–03:35:52 UTC (September 9, 23:33–23:35 EDT). Those requests were anonymous GETs; the sections below preserve those initial observations. The later authorized registration and signed upload are recorded in the final section. The isolated official-runner Docker smoke also passed.

## Identity and endpoints

Official [wallet instructions](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/docs/wallet-setup.md#registering-on-subnet) designate **testnet netuid 155**, versus mainnet 6. [Validator configuration](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/validator/utils/config.py#L13-L20) independently pairs network `test` with 155. This verifies the project's declared identity, not current on-chain ownership, registration availability, or validator activity.

The current [CLI configuration](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/miner/scripts/numinous_config.py) maps `--env test` to **https://stg.numinous.earth** and `prod` to https://numinous.earth. No production API or chain operation was performed.

| Anonymous GET | Observed result |
|---|---|
| [Test health](https://stg.numinous.earth/api/health) | **200**, `{"status":"ok"}` |
| [Test OpenAPI](https://stg.numinous.earth/api/openapi.json) | **200**, OpenAPI 3.1.0; title `SN6 API`, API version `0.1.0` |
| [Test Swagger docs](https://stg.numinous.earth/api/docs) | **200**, HTML referencing `/api/openapi.json` |
| [Public live events](https://stg.numinous.earth/api/v2/events?limit=1) | **200**, `{"count":0,"items":[],"has_more":false}` |
| [Miner agents](https://stg.numinous.earth/api/v3/miner/agents?limit=1) | **401**, missing/invalid Authorization header |
| [Miner services](https://stg.numinous.earth/api/v3/miner/services) | **401**, same authentication error |
| [Unprefixed health](https://stg.numinous.earth/health), [OpenAPI](https://stg.numinous.earth/openapi.json), [docs](https://stg.numinous.earth/docs) | **404**, `{"detail":"Not Found"}` |

Also checked `/`, `/healthz`, and `/api/v1/health`: 404. The working prefix is `/api`.

The live schema advertises `POST /api/v3/miner/upload_agent` and `POST /api/v3/miner/services/link`, along with the inference routes below. **These POST routes were not called.** Schema defaults for upload/link track remain `MAIN`; any later authorized submission should explicitly select `SIGNAL` and environment `test`.

## Registration and admission

The [official prerequisites](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/docs/subnet-rules.md#registration-requirements) are a coldkey/hotkey pair, subnet registration, and TAO for the variable registration cost. The wallet guide supplies `btcli subnet register --netuid 155 ... --network test` and a [test-TAO faucet](https://taoswap.org/testnet-faucet). Neither registration nor faucet availability was tested.

[Upload authentication](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/miner/scripts/upload_agent.py#L234-L279) signs the hotkey address and file hash. The public client does not request a mainnet UID or implement an admission allowlist. **That does not prove the backend accepts testnet-only identities.** The inspected docs and live schema do not settle that policy, and the anonymous 401 responses occur before membership can be evaluated. No authenticated admission attempt was made.

## SIGNAL inference and costs

The [authoritative allowlist](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/validator/sandbox/signing_proxy/track_config.py) and live test schema agree:

| Service | SIGNAL route / requirement |
|---|---|
| OpenRouter | `/api/gateway/openrouter/chat/completions/inference`; linked OpenRouter API key |
| OpenAI | `/api/gateway/openai/responses/inference`; linked OpenAI API key |
| Lightning Rod | `/api/gateway/lightning-rod/chat/completions`; linked account |
| Direct Chutes | **Unsupported**; no SIGNAL prefix or live schema route |
| Numinous Indicia | Free signal data, no key linking; not LLM inference |
| Numinous Signals | Separate linked signal-data service; not LLM inference |

The [changelog](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/CHANGELOG.md#L13-L35) records Chutes leaving SIGNAL on June 22 and its gateway endpoint being removed on August 4. Older Chutes setup guidance is obsolete.

The [gateway guide](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/docs/gateway-guide.md#overview) lists $0.10/run for OpenRouter, $1/run for OpenAI, and token-metered Lightning Rod. These are not a verified flat bill: [OpenRouter cost accounting](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/validator/models/openrouter.py#L29-L32) uses returned usage cost, while the live API documents budget-limit errors. No testnet billing exemption was found. Miners cover API costs and [must re-link after uploads](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/docs/subnet-rules.md#api-access); linking itself [requires a hotkey signature and provider key](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/miner/scripts/link_service.py#L145-L173).

OpenRouter [lists Chutes as a provider](https://openrouter.ai/provider/chutes) and supports [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection). That is an indirect OpenRouter route requiring OpenRouter credentials; a Chutes key alone is insufficient. Numinous-to-Chutes routing through OpenRouter was not exercised. OpenRouter also offers [free models](https://openrouter.ai/docs/guides/routing/routers/free-router), but Numinous's guide says its OpenRouter integration has no free tier; zero-cost use through Numinous is **unverified**.

## Blocker and single next action

**Observed blocker to a public live-event smoke:** the test events endpoint returned no events. This does not establish that validator-only feeds are empty or that the subnet is down. Mainnet-UID/allowlist policy, current testnet registration cost/slots, active validators, and signed upload acceptance remain unknown. The offline runner proof is already complete.

## Finalized testnet registry follow-up

The main agent subsequently completed an anonymous, wallet-free read of
`wss://test.finney.opentensor.ai:443`, fixed to netuid **155**:

- Finalized block **7972446**, hash `0x71af780b88fd219949ef7f6a8ed1cf2ea166f5cdd7a338d185f0e5b379bc080b`.
- Genesis `0x8f9cf856bf558a14440e75569c9e58594757048d7b3a84b5d25f6bd978263105`.
- Subnet exists; registration allowed; burn **500000 rao = 0.0005 tTAO**, excluding fees.
- 256/256 occupied neuron slots. Occupancy does not itself mean registration is disabled; the chain reports registration allowed.
- Two active neurons. Of the validator-permitted UIDs, **UID38** is active and has `lastUpdate=7972389`, **57 blocks** before the finalized snapshot.
- `subnetIdentitiesV3(155)` is null. The Numinous identity mapping comes from its official source/docs; the chain itself did not supply a name.

This establishes recent on-chain validator activity, **not** that the empty
public events feed is sufficient for testing or that the API will accept a new
testnet-only miner. No registration, upload, provider linking, or other signing
occurred. Existing Gradients and search containers remained running.

The repeatable offline check is in
[`dev/experiments/numinous-compose`](../../dev/experiments/numinous-compose/README.md).

## Registered and submitted — 2026-09-10 03:52 UTC

The authorized follow-up used only `wss://test.finney.opentensor.ai:443`
and `https://stg.numinous.earth`. Drift's existing remote hotkey was reused:
`5Cd2Nvkmd3mjFz4LPyJo8P4v8ddiHQo1yabfX9Qzv7d1RBGc`.

- Preflight confirmed testnet, registration allowed, treasury ownership of the
  hotkey, and enough spendable test funds for the 0.0005 tTAO burn plus the
  estimated 0.002141782 tTAO transaction fee. The estimate is not a charged-fee receipt.
- Registration returned **UID76** and transaction
  `0xdb847e42e940f117081978792755792c88af41ccb7f64237c7ac09a50f44a53e`.
- Independently verified the transaction in canonical block **7972495**
  (`0x16135771e2d327a32393d9c6c7ae9ed025c200801de1ef339ac9bc73dd58475a`)
  and UID76 at finalized block **7972503**.
- Uploaded the unchanged official `hello_world.py` to **SIGNAL**. No existing
  agent was replaced. Its SHA-256 is
  `9bf54fd0321ca770e8ed06f7aa6f656afaaba4de7a397d28f12ae0a9096b38ab`.
- Upload accepted as `Fez drift testnet baseline`, version 0,
  ID `14cfd757-78a3-4f46-9cfa-115ff0142ec8`, created at
  `2026-09-10T03:52:19.873896Z`. A separate signed GET returned the same version
  and `activated_at: null`; a services GET returned no linked credentials.

This resolves API admission for Drift's testnet registration. It does not
establish general backend admission policy. The agent returns probability 0.5
without inference calls; it is a submission baseline, not a competitive
forecaster. Existing Gradients and search containers remained running, with no
new rental. No mainnet action or paid provider linking occurred.

The [official activation rules](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/docs/subnet-rules.md#code-activation-schedule)
schedule activation at the next 00:00 UTC, **September 11, 2026 at 00:00 UTC /
September 10 at 8 p.m. EDT** for this upload. That is a documented schedule,
not an observed activation or execution. Uploads are limited to once every
three days, so test improvements locally before the next permitted submission.

**Next action:** after the scheduled activation time, run
`node dev/experiments/numinous-compose/submit-testnet.cjs status` and check
`activatedAt`. Execution and scoring require separate evidence afterward.
