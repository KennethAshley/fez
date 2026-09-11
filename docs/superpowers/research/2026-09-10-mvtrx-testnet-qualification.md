# MVTRX / τaos testnet qualification

Checked 2026-09-10. **Testnet 366 simulation mining qualifies for an integration spike.** Fez does not support it yet; no Fez miner was deployed or scored. No wallet, registration or spending was involved in this research.

## Evidence

- The official [FAQ](https://github.com/taos-im/sn-79/blob/main/FAQ.md) identifies testnet 366 and a continuously operated simulation validator.
- The [runtime guide](https://github.com/taos-im/sn-79#run) documents test-network registration and configurable endpoint, netuid, agent class/path/parameters, wallet and axon port. Native installation is supported; an official container deployment is not provided.
- Anonymous finalized chain block **7978583**, hash `0x9eca65d7cf9013689bcf89dbb4469b61d239c61c73f37c00219be39b94ae1b09`, identifies subnet 366 as τaos with repository `taos-im/sn-79`. Registration was enabled; 256/256 slots occupied. Validator UID0 was active, with last update7978548 (35 blocks earlier). Full capacity means registration may replace a miner.
- The official [testnet Agents dashboard](https://testnet.simulate.trading/d/edy6vxytuud4wd/agents) returned **257 score series** for netuid366, timestamp1789085400, seven seconds old at inspection. Simulation ID `20260910_2159`; agent1 score `0.785920739174`. This is live score telemetry, not just an HTTP200 response.

## Simulation versus exchange

The current README and FAQ say testnet has no **exchange**. The repository distinguishes simulation from its separate exchange/localnet path. The live dashboard establishes simulation scoring on366, not exchange participation. Keep Wallet on the Bittensor test network; do not route users to mainnet or the exchange.

## Proposed Fez demonstration

User asks a coding agent to create a simulation strategy → configures it in Mining → approves testnet registration/deployment → watches externally reported scores → asks the agent to improve the version. Record source identity for each run. The strategy implements `respond(state)` in a Python agent class; Fez develops it while the miner handles timed validator requests. See the [agent contract](https://github.com/taos-im/sn-79/tree/main/agents).

Before advertising support, implement the adapter and obtain a validator response and score tied to our deployed testnet miner. Publicly reachable hosting is required; none was provisioned. Keep optional training and exchange features outside the initial scope. Testnet rewards and simulated PnL are not real-money earnings.

## Reproduce the anonymous reads

Chain: `wss://test.finney.opentensor.ai:443`, finalized storage `networksAdded`, `subnetIdentitiesV3`, `networkRegistrationAllowed`, `subnetworkN`, `validatorPermit`, `active`, `lastUpdate` for366. Local snapshot: `/private/tmp/fez-taos-qualification-chain.json`.

Dashboard definition: `GET https://testnet.simulate.trading/api/dashboards/uid/edy6vxytuud4wd`.

Its public datasource: `GET https://testnet.simulate.trading/api/datasources/proxy/uid/d4bafaf4-1a3e-49dc-b674-3d7f08102104/api/v1/query`, query parameter `miner_gauges{netuid="366",miner_gauge_name="score"}`. Local response: `/private/tmp/fez-mvtrx-live-scores.json`.

Numinous155 also had an active validator at finalized7978580 (UID38, updated126 blocks earlier), with registration enabled. It is already integrated, so it is not the new-subnet recommendation. Neither chain activity nor public telemetry proves an individual Fez agent has been evaluated.
