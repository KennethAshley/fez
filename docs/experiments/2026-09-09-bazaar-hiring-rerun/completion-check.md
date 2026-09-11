# Completion check — follow-up

The unfinished-reply fix is deployed to all four seed miners. The installed Bazaar extension and both local CLI copies were also updated; the installed MCP bridge initialized and listed all three tools successfully.

The exact failed-pilot output, `[lookup 2] FETCH: https://raw.githubusercontent.com/nostr-protocol/nips/master/01.md`, now enters the existing two-round lookup loop. If the model still requests a lookup after that limit, its signed result is `failure`. No fallback sentence becomes a successful answer. Token-truncated answers also return `failure`, retaining any partial text under an unfinished-output label.

Bridge reports expose `successful_answers`; failures, declines, empty answers and duplicate retries do not increase that count. Directed-hire logging uses this count instead of treating every nonempty JSON report as an answer. Failure responses remain visible to the buyer.

## Verification

- Bazaar: **280 tests passed**, including the actual miner process publishing signed results through a local relay to the real bridge. Mocked provider responses cover finished text, the exact lookup marker, truncation and capacity refusal; no external model calls occur.
- Both TypeScript checks passed. The extension and Linux miner built. Fez: **1,416 tests passed, one skipped**.
- Deployed binary SHA-256: `a7a46c60f4bd4196a3c1a472cece6d4b2a4fc78f5cb040dbb078d0474a57cbb3`, matching the local build. All four services are active. [Digest and service check](completion-deployed-miner.txt), [deployment log](completion-deployment.log).
- Installed bundles match the build; prior copies were backed up. [Installed paths, hashes and backup](completion-installed-extension.json).

**Additional pilot model spend: $0.** The prior reported cumulative estimate remains about **$2.29** against the original $20 limit. Historical pilot replies and scores were not rewritten.

## Remaining limits

This check detects unfinished output, not factual correctness. It verifies delivery of failure status to the buyer; a new model-driven recovery trial and wallet settlement remain untested. Already-running desktop/agent processes load updated bundles on their next launch.

During deployment preparation, Forge and Drift had terminal Chutes HTTP 402 quota errors. Their active service state does not establish that they can answer. The availability rule currently covers operator spend/rate limits, not provider quota failures; address that before treating all four as available in another hiring trial. No provider funds or configuration were changed.
