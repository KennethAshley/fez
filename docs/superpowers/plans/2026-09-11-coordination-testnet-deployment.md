# Coordination-miner testnet deployment

Ken authorized deployment with an explicit testnet-only requirement. Existing gauntlet spending approvals are consumed; this rollout does not authorize another paid trial, specialist payment, or a change to reward policy.

1. [x] Verify the server's effective chain settings, official endpoint, recorded testnet genesis, and subnet 553 existence. Preserve service/configuration/artifact baselines.
2. [x] Build and review the server artifacts, fail-closed testnet startup check, and the durable Mac evaluation runtime/installed extension updates. Preserve existing profiles, keys, permissions, wallet settings, and spend ledgers.
3. [x] Deploy atomically with dated artifact backups. Restart only existing Bazaar services during an idle round boundary; keep the coordination job unset and preserve existing testnet research/weight configuration. Refresh the local Bazaar and wallet guard artifacts without replacing the installed desktop or its global runtime.
4. [x] Verify running artifact hashes, testnet startup guard, public board, and inference-free local agent previews. Record exact rollout/rollback locations and remaining launch requirements.

## Verified boundary

- Official endpoint: `wss://test.finney.opentensor.ai:443`.
- Testnet genesis: `0x8f9cf856bf558a14440e75569c9e58594757048d7b3a84b5d25f6bd978263105`, matching earlier recorded testnet experiments and fresh RPC/storage reads.
- Existing subnet: 553. Server SDK: Bittensor 11.1.0.
- Running validator explicitly pins `test` and netuid 553. Its startup guard passed and refuses startup if the network, subnet, endpoint, or genesis differs. No one-shot coordination job is set.
- Existing standing research services continue their configured operation. Deployment must not insert a one-shot job into their `Restart=always` unit.
- The actual agent and native speech tools remain on the Mac. A versioned Bazaar evaluation runtime avoids the installed desktop replacing it with an older bundled runtime. The reviewed Opus 5 selection is an evaluation-only fallback when no explicit model is selected.
- Rollback restores executable/static artifacts and deployment-specific unit changes, never spend ledgers or signed outcomes.

Operational evidence and release preparation: `/private/tmp/fez-bazaar-testnet-deploy-20260911`.

Completed at approximately 04:04 UTC on 2026-09-11. All five Bazaar services run verified artifacts; both installed Mac previews are ready. No new paid gauntlet job was started. See the [deployment report and retained evidence](../../experiments/2026-09-11-bazaar-testnet-deployment.md).
